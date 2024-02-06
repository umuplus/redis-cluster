import axios from 'axios';
import {
    addMasterIpAddressesToLoadBalancer,
    getTargetGroupIpAddresses,
    removeMasterIpAddressesFromLoadBalancer,
} from './nlb';
import { clusterFiles } from './config';
import { execSync } from 'child_process';
import { getInstanceIds, getEC2Details, getInstances, parsePM2Usage } from './asg';
import { getOwnerNodeIP, putOwnerNodeIP } from './db';
import { parseRedisMonitor, parseRedisNodes } from './redis';
import { writeFileSync } from 'fs';

let locked = false;
const delay = 60000 * 15; // * 15 minutes

let sourceCodeLastUpdatedAt: number | undefined;

export async function checkRedisClusterHealth() {
    try {
        if (locked) {
            console.log('Health check is locked');
            return;
        }

        locked = true;
        if (!clusterFiles.ipAddress) throw new Error('I do not know my own IP address :(');

        // * check redis service status
        const redisServiceStatusCommand = 'systemctl status --no-pager redis';
        console.log('>', redisServiceStatusCommand);
        const redisServiceStatus = execSync(redisServiceStatusCommand)
            .toString()
            .includes('active (running)');
        if (!redisServiceStatus) {
            console.log('redis service is not running, restarting...');
            execSync('sudo service redis restart'); // ? shutdown instead?
        }

        // * check redis cluster status
        const redisClusterStatusCommand = `redis-cli -a ${clusterFiles.password} cluster info`;
        console.log('>', redisClusterStatusCommand);
        const redisClusterStatus = execSync(redisClusterStatusCommand)
            .toString()
            .includes('cluster_state:ok');
        if (!redisClusterStatus) {
            console.log('redis cluster is not running');

            if (clusterFiles.adminApiKey) {
                try {
                    const monitorEC2 = await getEC2Details()
                    const monitorPM2Raw = execSync('pm2 list').toString()
                    const monitorPM2 = parsePM2Usage(monitorPM2Raw)

                    const monitor = {
                        ec2: monitorEC2,
                        pm2: monitorPM2,
                    }
                    writeFileSync('/tmp/redis-cluster-monitor-' + process.env.NODE_APP_INSTANCE, JSON.stringify(monitor, null, 2))
                    await axios.post(`https://api.prod.retter.io/cn6mbumkh/CALL/RedisMonitor/tick/default`, monitor, {
                        headers: { 'x-api-key': clusterFiles.adminApiKey },
                    })
                } catch (e) {
                    console.error((e as Error).message)
                }
            }

            // * check if the instances in the ASG are healthy and ready for the cluster
            const instanceIds = await getInstanceIds();
            const instances = await getInstances(instanceIds);
            const instanceList = Object.values(instances);
            const myInstance = instanceList.find(
                (instance) => instance.PrivateIpAddress === clusterFiles.ipAddress
            );
            if (!myInstance)
                throw new Error(`Instance ${clusterFiles.ipAddress} not found in the ASG.`);

            // * take over the owner node
            await putOwnerNodeIP(clusterFiles.ipAddress);

            // * create the cluster with the instances in the ASG
            const ipPortPairs = instanceList
                .map((instance) => `${instance.PublicIpAddress}:6379`)
                .join(' ');
            const replicaConfig = `--cluster-replicas ${clusterFiles.replicas}`;
            const createClusterCommand = `redis-cli -a ${clusterFiles.password} --cluster create ${ipPortPairs} ${replicaConfig} --cluster-yes`;
            console.log('>', createClusterCommand);
            execSync(createClusterCommand, { stdio: 'inherit' });

            console.log('waiting for the cluster to be ready...');
            let clusterReadySteps = 0;
            while (true) {
                clusterReadySteps++;
                await new Promise((resolve) => setTimeout(resolve, 5000));

                console.log('>', redisClusterStatusCommand);
                const redisClusterStatus = execSync(redisClusterStatusCommand)
                    .toString()
                    .includes('cluster_state:ok');
                if (redisClusterStatus) break;
                else if (clusterReadySteps > 10) throw new Error('Creating cluster failed');
            }

            const clusterNodesCommand = `redis-cli -a ${clusterFiles.password} cluster nodes`;
            console.log('>', clusterNodesCommand);
            const nodesRaw = execSync(clusterNodesCommand).toString();
            const nodes = parseRedisNodes(nodesRaw);
            const nodeList = Object.values(nodes);

            // * detect master nodes and add them to the load balancer
            const masterIps = nodeList
                .filter((node) => node.master)
                .map(
                    ({ ip }) =>
                        instanceList.find((instance) => instance.PublicIpAddress === ip)
                            ?.PrivateIpAddress!
                )
                .filter((ip) => ip);
            if (masterIps.length) await addMasterIpAddressesToLoadBalancer(masterIps);
        } else {
            if (!sourceCodeLastUpdatedAt || Date.now() - sourceCodeLastUpdatedAt > delay) {
                if (!sourceCodeLastUpdatedAt) sourceCodeLastUpdatedAt = Date.now();

                // * git pull
                const gitPullCommand = 'git pull';
                console.log('>', gitPullCommand);
                const sourceCodeChange = execSync(gitPullCommand).toString();
                if (!sourceCodeChange.includes('Already up to date.')) {
                    locked = false;
                    sourceCodeLastUpdatedAt = Date.now();
                    if (sourceCodeChange.includes('package.json')) {
                        console.log('package.json is updated, installing dependencies...');
                        execSync('npm install');
                    }
                    console.log('Source code is updated, restarting...');
                    process.exit(0);
                }
            }

            // * get instances from asg
            const instanceIds = await getInstanceIds();
            const instances = await getInstances(instanceIds);
            const instanceList = Object.values(instances);
            const myInstance = instanceList.find(
                (instance) => instance.PrivateIpAddress === clusterFiles.ipAddress
            );
            if (!myInstance)
                throw new Error(`Instance ${clusterFiles.ipAddress} not found in the ASG.`);

            const myPublicIp = myInstance.PublicIpAddress!;

            // * fetch cluster nodes
            const clusterNodesCommand = `redis-cli -a ${clusterFiles.password} cluster nodes`;
            console.log('>', clusterNodesCommand);
            const nodesRaw = execSync(clusterNodesCommand).toString();
            let nodes = parseRedisNodes(nodesRaw);
            let nodeList = Object.values(nodes);

            if (clusterFiles.adminApiKey) {
                try {
                    // * monitor redis cluster
                    const monitorRedisCommand = `redis-cli -a ${clusterFiles.password} client list`
                    console.log('>', monitorRedisCommand)
                    const monitorRedisRaw = execSync(monitorRedisCommand).toString()
                    const monitorRedis = parseRedisMonitor(monitorRedisRaw)

                    const monitorEC2 = await getEC2Details()
                    const monitorPM2Raw = execSync('pm2 list').toString()
                    const monitorPM2 = parsePM2Usage(monitorPM2Raw)

                    const monitor = {         
                        clientList: monitorRedis,  
                        cluster: nodes,
                        ec2: monitorEC2,
                        pm2: monitorPM2,
                    }
                    writeFileSync('/tmp/redis-cluster-monitor-' + process.env.NODE_APP_INSTANCE, JSON.stringify(monitor, null, 2))
                    await axios.post(`https://api.prod.retter.io/cn6mbumkh/CALL/RedisMonitor/tick/default`, monitor, { headers: { 'x-api-key': clusterFiles.adminApiKey } })
                } catch (e) {
                    console.error((e as Error).message)
                }
            }

            if (nodes[myPublicIp]?.master) {
                const ownerIp = await getOwnerNodeIP();
                if (!ownerIp) throw new Error('Master node IP not found in the DB');

                const ownerInstance = instanceList.find(
                    (instance) => instance.PrivateIpAddress === ownerIp
                );
                if (ownerInstance && ownerIp === clusterFiles.ipAddress) {
                    // * I am the owner node. Let's check if there are new nodes in the ASG
                    const newInstanceIps = instanceList
                        .filter(({ PublicIpAddress }) => PublicIpAddress && !nodes[PublicIpAddress])
                        .map(({ PublicIpAddress }) => PublicIpAddress!);
                    let mustRebalance = false;
                    if (newInstanceIps.length) {
                        // * add new nodes to the cluster
                        for (const ip of newInstanceIps) {
                            const command = `redis-cli -a ${clusterFiles.password} cluster meet ${ip} 6379`;
                            console.log('>', command);
                            execSync(command);
                        }
                        mustRebalance = true;

                        // * wait for the new nodes to be healthy as new masters
                        await new Promise((resolve) => setTimeout(resolve, 5000));

                        // * fetch new master nodes without slaves
                        console.log('>', clusterNodesCommand);
                        const nodesRaw = execSync(clusterNodesCommand).toString();
                        nodes = parseRedisNodes(nodesRaw);
                        nodeList = Object.values(nodes);
                    }

                    const mastersWithoutSlaves = nodeList.filter(
                        (node) => node.healthy && node.master && !node.slaves?.length
                    );
                    if (mastersWithoutSlaves.length) {
                        console.log(
                            'these nodes do not have slaves:',
                            mastersWithoutSlaves.map(({ ip }) => ip).join(', ')
                        );
                        for (let i = 0; i < mastersWithoutSlaves.length; i++) {
                            if (i % 2 === 0) continue;

                            const master = mastersWithoutSlaves[i - 1];
                            const slave = mastersWithoutSlaves[i];
                            const command = `redis-cli -h ${slave.ip} -a ${clusterFiles.password} cluster replicate ${master.id}`;
                            console.log('>', command);
                            execSync(command);
                        }
                        mustRebalance = true;
                    }

                    // * Check if there are unhealthy nodes in the cluster
                    const unhealthyNodes = nodeList.filter(({ healthy }) => !healthy);
                    if (unhealthyNodes.length) {
                        // * remove unhealthy nodes from the cluster
                        for (const { id } of unhealthyNodes) {
                            const command = `redis-cli -a ${clusterFiles.password} cluster forget ${id}`;
                            console.log('>', command);
                            execSync(command);
                        }
                        mustRebalance = true;
                    }

                    if (mustRebalance) {
                        let steps = 0;
                        while (true) {
                            steps++;
                            if (steps > 10) break;

                            await new Promise((resolve) => setTimeout(resolve, 5000));

                            // * make sure the new nodes are healthy and the unhealthy nodes are removed
                            console.log('>', clusterNodesCommand);
                            nodes = parseRedisNodes(execSync(clusterNodesCommand).toString());
                            nodeList = Object.values(nodes);
                            const healthyNewNodes = Object.values(nodes).filter(
                                (node) => newInstanceIps.includes(node.ip) && node.healthy
                            );
                            const notRemovedUnhealthyNodes = Object.values(nodes).filter((node) =>
                                unhealthyNodes.find(({ id }) => id === node.id)
                            );
                            const newNodesAdded = healthyNewNodes.length === newInstanceIps.length;
                            if (newNodesAdded && !notRemovedUnhealthyNodes.length) break;
                        }

                        // * rebalance the cluster
                        const command = `redis-cli -a ${clusterFiles.password} cluster rebalance`;
                        console.log('>', command);
                        execSync(command).toString();
                    }

                    const targetGroupIps = await getTargetGroupIpAddresses();
                    console.log('target group ips', targetGroupIps.join(', '));

                    // * detect new healthy master nodes and add them to the load balancer
                    const newHealthyIps = nodeList
                        .filter(({ master, healthy }) => master && healthy)
                        .map(
                            ({ ip }) =>
                                instanceList.find(({ PublicIpAddress }) => PublicIpAddress === ip)
                                    ?.PrivateIpAddress!
                        )
                        .filter((ip) => ip && !targetGroupIps.includes(ip));
                    if (newHealthyIps.length) {
                        console.log('New healthy master nodes detected:', newHealthyIps.join(', '));
                        await addMasterIpAddressesToLoadBalancer(newHealthyIps);
                    }

                    // * detect unhealthy nodes and remove them from the load balancer
                    const unhealthyIps = targetGroupIps.filter((ip: any) => {
                        const publicIp = instanceList.find(
                            (instance) => instance.PrivateIpAddress === ip
                        )?.PublicIpAddress;
                        return (
                            !publicIp ||
                            !nodes[publicIp] ||
                            !nodes[publicIp].master ||
                            !nodes[publicIp].healthy
                        );
                    });
                    nodeList
                        .filter(({ healthy }) => !healthy)
                        .forEach(({ ip }) => {
                            const privateIp = instanceList.find(
                                (instance) => instance.PublicIpAddress === ip
                            )?.PrivateIpAddress;
                            if (privateIp && !unhealthyIps.includes(privateIp))
                                unhealthyIps.push(privateIp);
                        });
                    if (unhealthyIps.length) {
                        console.log('Unhealthy master nodes detected:', unhealthyIps.join(', '));
                        await removeMasterIpAddressesFromLoadBalancer(unhealthyIps);
                    }
                } else {
                    // * Check if the owner node is healthy
                    if (!ownerInstance || !nodes[ownerInstance.PublicIpAddress!]?.healthy) {
                        console.log(`Master node ${ownerIp} is not healthy, trying to take over.`);
                        try {
                            await putOwnerNodeIP(clusterFiles.ipAddress, ownerIp);
                        } catch (e) {
                            console.log('Cannot take over the owner node from', ownerIp);
                        }
                    }
                }
            }
        }
        locked = false;
    } catch (e) {
        locked = false;
        console.error((e as Error).message);
    }
}
