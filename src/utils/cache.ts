import {
    addMasterIpAddressesToLoadBalancer,
    getTargetGroupIpAddresses,
    removeMasterIpAddressesFromLoadBalancer,
} from './nlb';
import { clusterFiles } from './config';
import { execSync, spawn } from 'child_process';
import { getInstanceIds, getInstances } from './asg';
import { getOwnerNodeIP, putOwnerNodeIP } from './db';
import { parseRedisNodes } from './redis';

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
            const masterIps = nodeList.filter((node) => node.master).map(({ ip }) => ip);
            if (masterIps.length) await addMasterIpAddressesToLoadBalancer(masterIps);
        } else {
            if (!sourceCodeLastUpdatedAt || Date.now() - sourceCodeLastUpdatedAt > delay) {
                // * git pull
                const gitPullCommand = 'git pull';
                console.log('>', gitPullCommand);
                const sourceCodeChange = execSync(gitPullCommand).toString();
                if (!sourceCodeChange.includes('Already up to date.')) {
                    sourceCodeLastUpdatedAt = Date.now();
                    if (sourceCodeChange.includes('package.json')) {
                        console.log('package.json is updated, installing dependencies...');
                        execSync('npm install');
                    }
                    console.log('Source code is updated, restarting...');
                    spawn('pm2', [`restart all`], { detached: true, stdio: 'ignore' });
                    return;
                }
            }

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
            if (nodes[myPublicIp]?.master) {
                const ownerIp = await getOwnerNodeIP();
                if (!ownerIp) throw new Error('Master node IP not found in the DB');

                const ownerInstance = instanceList.find(
                    (instance) => instance.PrivateIpAddress === ownerIp
                );
                if (!ownerInstance)
                    throw new Error(`Owner Instance ${ownerIp} not found in the ASG.`);
                if (ownerIp === clusterFiles.ipAddress) {
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

                    // * detect new healthy nodes master nodes and add them to the load balancer
                    const newHealthyIps = nodeList
                        .filter(
                            ({ master, healthy, ip }) =>
                                master && healthy && !targetGroupIps.includes(ip)
                        )
                        .map(
                            ({ ip }) =>
                                instanceList.find((instance) => instance.PublicIpAddress === ip)
                                    ?.PrivateIpAddress!
                        )
                        .filter((ip) => ip);
                    if (newHealthyIps.length)
                        await addMasterIpAddressesToLoadBalancer(newHealthyIps);

                    // * detect unhealthy nodes and remove them from the load balancer
                    const existingUnhealthyIps = targetGroupIps.filter(
                        (ip) => !nodes[ip] || !nodes[ip].healthy
                    );
                    nodeList
                        .filter(({ healthy }) => !healthy)
                        .forEach(({ ip }) => {
                            const privateIp = instanceList.find(
                                (instance) => instance.PublicIpAddress === ip
                            )?.PrivateIpAddress;
                            if (privateIp && !existingUnhealthyIps.includes(privateIp))
                                existingUnhealthyIps.push(privateIp);
                        });
                    if (existingUnhealthyIps.length)
                        await removeMasterIpAddressesFromLoadBalancer(existingUnhealthyIps);
                } else {
                    // * Check if the owner node is healthy
                    if (!nodes[ownerInstance.PublicIpAddress!]?.healthy) {
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
