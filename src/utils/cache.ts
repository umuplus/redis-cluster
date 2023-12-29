import { clusterFiles } from './config';
import { execSync } from 'child_process';
import { getInstanceIds, getInstances } from './asg';
import { getMasterNodeIP, putMasterNodeIP } from './db';

const startedAt = Date.now();
const delay = 60000 * 10; // * 10 minutes

export async function checkRedisClusterHealth() {
    try {
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
            else if (instanceIds[0] !== myInstance.InstanceId)
                throw new Error(
                    `I am not the master. Let's wait for the master to create the cluster.`
                );

            // * create the cluster with the instances in the ASG
            const ipPortPairs = Object.values(instances)
                .map((node) => `${node.PrivateIpAddress}:6379`)
                .join(' ');
            const replicaConfig = `--cluster-replicas ${clusterFiles.replicas}`;
            const createClusterCommand = `redis-cli -a ${clusterFiles.password} --cluster create ${ipPortPairs} ${replicaConfig}`;
            console.log('>', createClusterCommand);
            execSync(createClusterCommand, { stdio: 'inherit' });
            await putMasterNodeIP(clusterFiles.ipAddress);
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
                const masterIp = await getMasterNodeIP();
                if (!masterIp) throw new Error('Master node IP not found in the DB');
                else if (masterIp === clusterFiles.ipAddress) {
                    // * I am the master node. Let's check if there are new nodes in the ASG
                    const instanceIds = await getInstanceIds();
                    const instances = await getInstances(instanceIds);
                    const newInstances = Object.values(instances).filter(
                        ({ PrivateIpAddress }) => PrivateIpAddress && !nodes[PrivateIpAddress]
                    );
                    if (newInstances.length) {
                        // ! add new nodes to the cluster
                    }

                    // * check if there are unhealthy nodes in the cluster
                    const unhealthyNodes = Object.entries(nodes).filter(
                        ([_, { healthy }]) => !healthy
                    );
                    if (unhealthyNodes.length) {
                        // ! remove unhealthy nodes from the cluster
                    }
                } else {
                    // * Check if the master node is healthy
                    if (!nodes[masterIp]?.healthy) {
                        console.log(`Master node ${masterIp} is not healthy`);
                        try {
                            await putMasterNodeIP(clusterFiles.ipAddress, masterIp);
                        } catch (e) {
                            console.log('Cannot take over the master node from', masterIp);
                        }
                    }
                }
            }
        }
    } catch (e) {
        console.error((e as Error).message);
    }
}

function parseRedisNodes(payload: string) {
    const nodes = payload.split('\n');
    return nodes.reduce((final: Record<string, { master: boolean; healthy: boolean }>, node) => {
        const [_, ipAddress, _flags, masterId, _ping, _pong, _epoch, status] = node.split(' ');
        const [ip] = ipAddress.split(':');
        final[ip] = { master: masterId === '-', healthy: status === 'connected' };
        return final;
    }, {});
}
