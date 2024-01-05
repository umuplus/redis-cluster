import { clusterFiles } from './config';
import { execSync } from 'child_process';
import { getInstanceIds, getInstances } from './asg';
import { getOwnerNodeIP, putOwnerNodeIP } from './db';
import { parseRedisNodes } from './redis';

let locked = false;
const startedAt = Date.now();
const delay = 60000 * 10; // * 10 minutes

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

            // * check if the instances in the ASG are healthy and ready for the cluster
            const instanceIds = await getInstanceIds();
            const instances = await getInstances(instanceIds);
            const myInstance = Object.values(instances).find(
                (instance) => instance.PrivateIpAddress === clusterFiles.ipAddress
            );
            if (!myInstance)
                throw new Error(`Instance ${clusterFiles.ipAddress} not found in the ASG.`);

            // * take over the owner node
            await putOwnerNodeIP(clusterFiles.ipAddress);

            // * create the cluster with the instances in the ASG
            const ipPortPairs = Object.values(instances)
                .map((node) => `${node.PrivateIpAddress}:6379`)
                .join(' ');
            const replicaConfig = `--cluster-replicas ${clusterFiles.replicas}`;
            const createClusterCommand = `redis-cli -a ${clusterFiles.password} --cluster create ${ipPortPairs} ${replicaConfig} --cluster-yes`;
            console.log('>', createClusterCommand);
            execSync(createClusterCommand, { stdio: 'inherit' });

            const redisClusterStatus = execSync(redisClusterStatusCommand)
            .toString()
            .includes('cluster_state:ok');

            if (!redisClusterStatus) throw new Error('Created cluster is not healthy');
        } else {
            if (Date.now() - startedAt < delay)
                throw new Error('Give the cluster some time to start');

            // * fetch cluster nodes
            const clusterNodesCommand = `redis-cli -a ${clusterFiles.password} cluster nodes`;
            console.log('>', clusterNodesCommand);
            const nodesRaw = execSync(clusterNodesCommand).toString();
            console.log(nodesRaw);
            const nodes = parseRedisNodes(nodesRaw);
            if (nodes[clusterFiles.ipAddress]?.master) {
                const ownerIp = await getOwnerNodeIP();
                if (!ownerIp) throw new Error('Master node IP not found in the DB');
                else if (ownerIp === clusterFiles.ipAddress) {
                    // * I am the owner node. Let's check if there are new nodes in the ASG
                    const instanceIds = await getInstanceIds();
                    const instances = await getInstances(instanceIds);
                    const newInstanceIps = Object.values(instances)
                        .filter(
                            ({ PrivateIpAddress }) => PrivateIpAddress && !nodes[PrivateIpAddress]
                        )
                        .map(({ PrivateIpAddress }) => PrivateIpAddress!);
                    let mustRebalance = false;
                    if (newInstanceIps.length) {
                        // * add new nodes to the cluster
                        for (const ip of newInstanceIps) {
                            const command = `redis-cli -a ${clusterFiles.password} cluster meet ${ip} 6379`;
                            console.log('>', command);
                            execSync(command).toString();
                        }
                        mustRebalance = true;
                    }

                    // * Check if there are unhealthy nodes in the cluster
                    const unhealthyNodes = Object.values(nodes).filter(({ healthy }) => !healthy);
                    if (unhealthyNodes.length) {
                        // * remove unhealthy nodes from the cluster
                        for (const { id } of unhealthyNodes) {
                            const command = `redis-cli -a ${clusterFiles.password} cluster forget ${id}`;
                            console.log('>', command);
                            execSync(command).toString();
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
                            const nodes = parseRedisNodes(execSync(clusterNodesCommand).toString());
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
                } else {
                    // * Check if the owner node is healthy
                    if (!nodes[ownerIp]?.healthy) {
                        console.log(
                            `Master node ${ownerIp} is not healthy. I am trying to take over.`
                        );
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
