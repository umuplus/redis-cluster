"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkRedisClusterHealth = void 0;
const nlb_1 = require("./nlb");
const config_1 = require("./config");
const child_process_1 = require("child_process");
const asg_1 = require("./asg");
const db_1 = require("./db");
const redis_1 = require("./redis");
let locked = false;
const delay = 60000 * 15; // * 15 minutes
let sourceCodeLastUpdatedAt;
async function checkRedisClusterHealth() {
    try {
        if (locked) {
            console.log('Health check is locked');
            return;
        }
        locked = true;
        if (!config_1.clusterFiles.ipAddress)
            throw new Error('I do not know my own IP address :(');
        // * check redis service status
        const redisServiceStatusCommand = 'systemctl status --no-pager redis';
        console.log('>', redisServiceStatusCommand);
        const redisServiceStatus = (0, child_process_1.execSync)(redisServiceStatusCommand)
            .toString()
            .includes('active (running)');
        if (!redisServiceStatus) {
            console.log('redis service is not running, restarting...');
            (0, child_process_1.execSync)('sudo service redis restart'); // ? shutdown instead?
        }
        // * check redis cluster status
        const redisClusterStatusCommand = `redis-cli -a ${config_1.clusterFiles.password} cluster info`;
        console.log('>', redisClusterStatusCommand);
        const redisClusterStatus = (0, child_process_1.execSync)(redisClusterStatusCommand)
            .toString()
            .includes('cluster_state:ok');
        if (!redisClusterStatus) {
            console.log('redis cluster is not running');
            // * check if the instances in the ASG are healthy and ready for the cluster
            const instanceIds = await (0, asg_1.getInstanceIds)();
            const instances = await (0, asg_1.getInstances)(instanceIds);
            const instanceList = Object.values(instances);
            const myInstance = instanceList.find((instance) => instance.PrivateIpAddress === config_1.clusterFiles.ipAddress);
            if (!myInstance)
                throw new Error(`Instance ${config_1.clusterFiles.ipAddress} not found in the ASG.`);
            // * take over the owner node
            await (0, db_1.putOwnerNodeIP)(config_1.clusterFiles.ipAddress);
            // * create the cluster with the instances in the ASG
            const ipPortPairs = instanceList
                .map((instance) => `${instance.PublicIpAddress}:6379`)
                .join(' ');
            const replicaConfig = `--cluster-replicas ${config_1.clusterFiles.replicas}`;
            const createClusterCommand = `redis-cli -a ${config_1.clusterFiles.password} --cluster create ${ipPortPairs} ${replicaConfig} --cluster-yes`;
            console.log('>', createClusterCommand);
            (0, child_process_1.execSync)(createClusterCommand, { stdio: 'inherit' });
            console.log('waiting for the cluster to be ready...');
            let clusterReadySteps = 0;
            while (true) {
                clusterReadySteps++;
                await new Promise((resolve) => setTimeout(resolve, 5000));
                console.log('>', redisClusterStatusCommand);
                const redisClusterStatus = (0, child_process_1.execSync)(redisClusterStatusCommand)
                    .toString()
                    .includes('cluster_state:ok');
                if (redisClusterStatus)
                    break;
                else if (clusterReadySteps > 10)
                    throw new Error('Creating cluster failed');
            }
            const clusterNodesCommand = `redis-cli -a ${config_1.clusterFiles.password} cluster nodes`;
            console.log('>', clusterNodesCommand);
            const nodesRaw = (0, child_process_1.execSync)(clusterNodesCommand).toString();
            const nodes = (0, redis_1.parseRedisNodes)(nodesRaw);
            const nodeList = Object.values(nodes);
            // * detect master nodes and add them to the load balancer
            const masterIps = nodeList
                .filter((node) => node.master)
                .map(({ ip }) => instanceList.find((instance) => instance.PublicIpAddress === ip)
                ?.PrivateIpAddress)
                .filter((ip) => ip);
            if (masterIps.length)
                await (0, nlb_1.addMasterIpAddressesToLoadBalancer)(masterIps);
        }
        else {
            if (!sourceCodeLastUpdatedAt || Date.now() - sourceCodeLastUpdatedAt > delay) {
                // * git pull
                const gitPullCommand = 'git pull';
                console.log('>', gitPullCommand);
                const sourceCodeChange = (0, child_process_1.execSync)(gitPullCommand).toString();
                if (!sourceCodeChange.includes('Already up to date.')) {
                    locked = false;
                    sourceCodeLastUpdatedAt = Date.now();
                    if (sourceCodeChange.includes('package.json')) {
                        console.log('package.json is updated, installing dependencies...');
                        (0, child_process_1.execSync)('npm install');
                    }
                    console.log('Source code is updated, restarting...');
                    process.exit(0);
                }
            }
            const instanceIds = await (0, asg_1.getInstanceIds)();
            const instances = await (0, asg_1.getInstances)(instanceIds);
            const instanceList = Object.values(instances);
            const myInstance = instanceList.find((instance) => instance.PrivateIpAddress === config_1.clusterFiles.ipAddress);
            if (!myInstance)
                throw new Error(`Instance ${config_1.clusterFiles.ipAddress} not found in the ASG.`);
            const myPublicIp = myInstance.PublicIpAddress;
            // * fetch cluster nodes
            const clusterNodesCommand = `redis-cli -a ${config_1.clusterFiles.password} cluster nodes`;
            console.log('>', clusterNodesCommand);
            const nodesRaw = (0, child_process_1.execSync)(clusterNodesCommand).toString();
            let nodes = (0, redis_1.parseRedisNodes)(nodesRaw);
            let nodeList = Object.values(nodes);
            if (nodes[myPublicIp]?.master) {
                const ownerIp = await (0, db_1.getOwnerNodeIP)();
                if (!ownerIp)
                    throw new Error('Master node IP not found in the DB');
                const ownerInstance = instanceList.find((instance) => instance.PrivateIpAddress === ownerIp);
                if (ownerInstance && ownerIp === config_1.clusterFiles.ipAddress) {
                    // * I am the owner node. Let's check if there are new nodes in the ASG
                    const newInstanceIps = instanceList
                        .filter(({ PublicIpAddress }) => PublicIpAddress && !nodes[PublicIpAddress])
                        .map(({ PublicIpAddress }) => PublicIpAddress);
                    let mustRebalance = false;
                    if (newInstanceIps.length) {
                        // * add new nodes to the cluster
                        for (const ip of newInstanceIps) {
                            const command = `redis-cli -a ${config_1.clusterFiles.password} cluster meet ${ip} 6379`;
                            console.log('>', command);
                            (0, child_process_1.execSync)(command);
                        }
                        mustRebalance = true;
                        // * wait for the new nodes to be healthy as new masters
                        await new Promise((resolve) => setTimeout(resolve, 5000));
                        // * fetch new master nodes without slaves
                        console.log('>', clusterNodesCommand);
                        const nodesRaw = (0, child_process_1.execSync)(clusterNodesCommand).toString();
                        nodes = (0, redis_1.parseRedisNodes)(nodesRaw);
                        nodeList = Object.values(nodes);
                    }
                    const mastersWithoutSlaves = nodeList.filter((node) => node.healthy && node.master && !node.slaves?.length);
                    if (mastersWithoutSlaves.length) {
                        console.log('these nodes do not have slaves:', mastersWithoutSlaves.map(({ ip }) => ip).join(', '));
                        for (let i = 0; i < mastersWithoutSlaves.length; i++) {
                            if (i % 2 === 0)
                                continue;
                            const master = mastersWithoutSlaves[i - 1];
                            const slave = mastersWithoutSlaves[i];
                            const command = `redis-cli -h ${slave.ip} -a ${config_1.clusterFiles.password} cluster replicate ${master.id}`;
                            console.log('>', command);
                            (0, child_process_1.execSync)(command);
                        }
                        mustRebalance = true;
                    }
                    // * Check if there are unhealthy nodes in the cluster
                    const unhealthyNodes = nodeList.filter(({ healthy }) => !healthy);
                    if (unhealthyNodes.length) {
                        // * remove unhealthy nodes from the cluster
                        for (const { id } of unhealthyNodes) {
                            const command = `redis-cli -a ${config_1.clusterFiles.password} cluster forget ${id}`;
                            console.log('>', command);
                            (0, child_process_1.execSync)(command);
                        }
                        mustRebalance = true;
                    }
                    if (mustRebalance) {
                        let steps = 0;
                        while (true) {
                            steps++;
                            if (steps > 10)
                                break;
                            await new Promise((resolve) => setTimeout(resolve, 5000));
                            // * make sure the new nodes are healthy and the unhealthy nodes are removed
                            console.log('>', clusterNodesCommand);
                            nodes = (0, redis_1.parseRedisNodes)((0, child_process_1.execSync)(clusterNodesCommand).toString());
                            nodeList = Object.values(nodes);
                            const healthyNewNodes = Object.values(nodes).filter((node) => newInstanceIps.includes(node.ip) && node.healthy);
                            const notRemovedUnhealthyNodes = Object.values(nodes).filter((node) => unhealthyNodes.find(({ id }) => id === node.id));
                            const newNodesAdded = healthyNewNodes.length === newInstanceIps.length;
                            if (newNodesAdded && !notRemovedUnhealthyNodes.length)
                                break;
                        }
                        // * rebalance the cluster
                        const command = `redis-cli -a ${config_1.clusterFiles.password} cluster rebalance`;
                        console.log('>', command);
                        (0, child_process_1.execSync)(command).toString();
                    }
                    const targetGroupIps = await (0, nlb_1.getTargetGroupIpAddresses)();
                    console.log('target group ips', targetGroupIps.join(', '));
                    // * detect new healthy master nodes and add them to the load balancer
                    const newHealthyIps = nodeList
                        .filter(({ master, healthy }) => master && healthy)
                        .map(({ ip }) => instanceList.find(({ PublicIpAddress }) => PublicIpAddress === ip)
                        ?.PrivateIpAddress)
                        .filter((ip) => ip && !targetGroupIps.includes(ip));
                    if (newHealthyIps.length) {
                        console.log('New healthy master nodes detected:', newHealthyIps.join(', '));
                        await (0, nlb_1.addMasterIpAddressesToLoadBalancer)(newHealthyIps);
                    }
                    // * detect unhealthy nodes and remove them from the load balancer
                    const unhealthyIps = targetGroupIps.filter((ip) => {
                        const publicIp = instanceList.find((instance) => instance.PrivateIpAddress === ip)?.PublicIpAddress;
                        return (!publicIp ||
                            !nodes[publicIp] ||
                            !nodes[publicIp].master ||
                            !nodes[publicIp].healthy);
                    });
                    nodeList
                        .filter(({ healthy }) => !healthy)
                        .forEach(({ ip }) => {
                        const privateIp = instanceList.find((instance) => instance.PublicIpAddress === ip)?.PrivateIpAddress;
                        if (privateIp && !unhealthyIps.includes(privateIp))
                            unhealthyIps.push(privateIp);
                    });
                    if (unhealthyIps.length) {
                        console.log('Unhealthy master nodes detected:', unhealthyIps.join(', '));
                        await (0, nlb_1.removeMasterIpAddressesFromLoadBalancer)(unhealthyIps);
                    }
                }
                else {
                    // * Check if the owner node is healthy
                    if (!ownerInstance || !nodes[ownerInstance.PublicIpAddress]?.healthy) {
                        console.log(`Master node ${ownerIp} is not healthy, trying to take over.`);
                        try {
                            await (0, db_1.putOwnerNodeIP)(config_1.clusterFiles.ipAddress, ownerIp);
                        }
                        catch (e) {
                            console.log('Cannot take over the owner node from', ownerIp);
                        }
                    }
                }
            }
        }
        locked = false;
    }
    catch (e) {
        locked = false;
        console.error(e.message);
    }
}
exports.checkRedisClusterHealth = checkRedisClusterHealth;
