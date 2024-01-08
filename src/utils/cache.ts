import { clusterFiles } from './config';
import { execSync } from 'child_process';
import { getInstances } from './ec2';
import { getOwnerNodeIP, putClusterInformation, putOwnerNodeIP } from './db';
import { parseRedisNodes } from './redis';
import { readFileSync } from 'fs';

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
            console.log('redis service is not running');
            const instances = await getInstances();
            const myInstance = instances.find(
                (instance) => instance.PrivateIpAddress === clusterFiles.ipAddress
            );
            if (!myInstance) throw new Error(`Instance ${clusterFiles.ipAddress} not found.`);

            const bind = `bind ${myInstance.PublicIpAddress}`;
            const redisConf = readFileSync('/etc/redis/redis.conf', 'utf-8');
            if (!redisConf.includes(bind)) {
                console.log('binding redis to', myInstance.PublicIpAddress);
                execSync(`echo '${bind}' | sudo tee -a /etc/redis/redis.conf`);
            }

            console.log('starting redis...');
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

            // * check if the instances are healthy and ready for the cluster
            const instances = await getInstances();
            const myInstance = instances.find(
                (instance) => instance.PrivateIpAddress === clusterFiles.ipAddress
            );
            if (!myInstance) throw new Error(`Instance ${clusterFiles.ipAddress} not found.`);

            // * take over the owner node
            await putOwnerNodeIP(clusterFiles.ipAddress);

            // * create the cluster
            const ipPortPairs = instances
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
            await putClusterInformation(JSON.stringify(nodes));
        } else {
            if (Date.now() - startedAt < delay)
                throw new Error('Give the cluster some time to start');

            // * fetch cluster nodes
            const clusterNodesCommand = `redis-cli -a ${clusterFiles.password} cluster nodes`;
            console.log('>', clusterNodesCommand);
            const nodesRaw = execSync(clusterNodesCommand).toString();
            const nodes = parseRedisNodes(nodesRaw);
            if (nodes[clusterFiles.ipAddress]?.master) {
                const ownerIp = await getOwnerNodeIP();
                if (!ownerIp) throw new Error('Master node IP not found in the DB');
                else if (ownerIp === clusterFiles.ipAddress) {
                    // * I am the owner node. Let's check if there are new nodes in the instances
                    const instances = await getInstances();
                    const newInstances = instances.filter(
                        (instance) => !nodes[instance.PublicIpAddress!]
                    );

                    let mustRebalance = false;
                    if (newInstances.length) {
                        // * add new nodes to the cluster
                        for (const instance of newInstances) {
                            const command = `redis-cli -a ${clusterFiles.password} cluster meet ${instance.PublicIpAddress} 6379`;
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
                                (node) =>
                                    newInstances.find((i) => i.PublicIpAddress === node.ip) &&
                                    node.healthy
                            );
                            const notRemovedUnhealthyNodes = Object.values(nodes).filter((node) =>
                                unhealthyNodes.find(({ id }) => id === node.id)
                            );
                            const newNodesAdded = healthyNewNodes.length === newInstances.length;
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
