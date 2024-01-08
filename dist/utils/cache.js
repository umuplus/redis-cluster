"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkRedisClusterHealth = void 0;
const config_1 = require("./config");
const child_process_1 = require("child_process");
const ec2_1 = require("./ec2");
const db_1 = require("./db");
const redis_1 = require("./redis");
let locked = false;
const startedAt = Date.now();
const delay = 60000 * 10; // * 10 minutes
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
            // * check if the instances are healthy and ready for the cluster
            const instances = await (0, ec2_1.getInstances)();
            if (!instances.includes(config_1.clusterFiles.ipAddress))
                throw new Error(`Instance ${config_1.clusterFiles.ipAddress} not found.`);
            // * take over the owner node
            await (0, db_1.putOwnerNodeIP)(config_1.clusterFiles.ipAddress);
            // * create the cluster
            const ipPortPairs = instances.map((ip) => `${ip}:6379`).join(' ');
            const replicaConfig = `--cluster-replicas ${config_1.clusterFiles.replicas}`;
            const createClusterCommand = `redis-cli -a ${config_1.clusterFiles.password} --cluster create ${ipPortPairs} ${replicaConfig} --cluster-yes`;
            console.log('>', createClusterCommand);
            (0, child_process_1.execSync)(createClusterCommand, { stdio: 'inherit' });
            console.log('>', redisClusterStatusCommand);
            const redisClusterStatus = (0, child_process_1.execSync)(redisClusterStatusCommand)
                .toString()
                .includes('cluster_state:ok');
            if (!redisClusterStatus)
                throw new Error('Creating cluster failed');
            const clusterNodesCommand = `redis-cli -a ${config_1.clusterFiles.password} cluster nodes`;
            console.log('>', clusterNodesCommand);
            const nodesRaw = (0, child_process_1.execSync)(clusterNodesCommand).toString();
            const nodes = (0, redis_1.parseRedisNodes)(nodesRaw);
            await (0, db_1.putClusterInformation)(JSON.stringify(nodes));
        }
        else {
            if (Date.now() - startedAt < delay)
                throw new Error('Give the cluster some time to start');
            // * fetch cluster nodes
            const clusterNodesCommand = `redis-cli -a ${config_1.clusterFiles.password} cluster nodes`;
            console.log('>', clusterNodesCommand);
            const nodesRaw = (0, child_process_1.execSync)(clusterNodesCommand).toString();
            const nodes = (0, redis_1.parseRedisNodes)(nodesRaw);
            if (nodes[config_1.clusterFiles.ipAddress]?.master) {
                const ownerIp = await (0, db_1.getOwnerNodeIP)();
                if (!ownerIp)
                    throw new Error('Master node IP not found in the DB');
                else if (ownerIp === config_1.clusterFiles.ipAddress) {
                    // * I am the owner node. Let's check if there are new nodes in the instances
                    const instances = await (0, ec2_1.getInstances)();
                    const newInstanceIps = instances.filter((ip) => !nodes[ip]);
                    let mustRebalance = false;
                    if (newInstanceIps.length) {
                        // * add new nodes to the cluster
                        for (const ip of newInstanceIps) {
                            const command = `redis-cli -a ${config_1.clusterFiles.password} cluster meet ${ip} 6379`;
                            console.log('>', command);
                            (0, child_process_1.execSync)(command).toString();
                        }
                        mustRebalance = true;
                    }
                    // * Check if there are unhealthy nodes in the cluster
                    const unhealthyNodes = Object.values(nodes).filter(({ healthy }) => !healthy);
                    if (unhealthyNodes.length) {
                        // * remove unhealthy nodes from the cluster
                        for (const { id } of unhealthyNodes) {
                            const command = `redis-cli -a ${config_1.clusterFiles.password} cluster forget ${id}`;
                            console.log('>', command);
                            (0, child_process_1.execSync)(command).toString();
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
                            const nodes = (0, redis_1.parseRedisNodes)((0, child_process_1.execSync)(clusterNodesCommand).toString());
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
                }
                else {
                    // * Check if the owner node is healthy
                    if (!nodes[ownerIp]?.healthy) {
                        console.log(`Master node ${ownerIp} is not healthy. I am trying to take over.`);
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
