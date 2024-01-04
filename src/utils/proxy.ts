import yaml from 'yaml';
import { clusterFiles } from './config';
import { execSync, spawn } from 'child_process';
import { getCacheAutoScalingGroup, getInstanceIds, getInstances } from './asg';
import { join as joinPath } from 'path';
import { parseRedisNodes } from './redis';
import { readFileSync, writeFileSync } from 'fs';

const envoyConfigPath = joinPath(__dirname, '..', '..', 'config', 'envoy.yaml');
const envoyConfig = yaml.parse(readFileSync(envoyConfigPath, 'utf-8'));
envoyConfig.static_resources.clusters[0].load_assignment.endpoints[0].lb_endpoints = [];

export async function checkRedisClusterProxy() {
    try {
        const asg = await getCacheAutoScalingGroup();
        if (!asg) throw new Error(`Auto scaling group not found for cache nodes.`);

        const instanceIds = await getInstanceIds(asg);
        const instances = await getInstances([instanceIds[0]]);
        const instance = Object.values(instances)[0];
        const clusterNodesCommand = `redis-cli -h ${instance.PrivateIpAddress} -a ${clusterFiles.password} cluster nodes`;
        console.log('>', clusterNodesCommand);
        const nodesRaw = execSync(clusterNodesCommand).toString();
        const nodes = parseRedisNodes(nodesRaw);
        const masterNodeIps = Object.values(nodes)
            .filter(({ master }) => master)
            .map(({ ip }) => ip)
            .sort();
        console.log('master node(s) :', masterNodeIps.join(','));
        if (masterNodeIps.length) {
            const existingIps = getExistingIpAddress();
            configureEnvoy(masterNodeIps);
            if (existingIps.join(',') !== masterNodeIps.join(',')) {
                writeFileSync(envoyConfigPath, yaml.stringify(envoyConfig));
                const checkIfEnvoyRunning = `ps aux | grep envoy | grep -v grep | awk '{print $2}'`;
                console.log('>', checkIfEnvoyRunning);
                const envoyRunning = execSync(checkIfEnvoyRunning).toString();
                if (envoyRunning) {
                    const killEnvoy = `pkill -9 envoy`;
                    console.log('>', killEnvoy);
                    execSync(killEnvoy);
                }
                spawn('envoy', [`-c ${envoyConfigPath}`], { detached: true, stdio: 'ignore' });
            }
        }
    } catch (e) {
        console.error((e as Error).message);
    }
}

function configureEnvoy(ipAddresses: string[]) {
    envoyConfig.static_resources.clusters[0].load_assignment.endpoints[0].lb_endpoints =
        ipAddresses.map((ip) => ({
            endpoint: {
                address: {
                    socket_address: {
                        address: ip,
                        port_value: 6379,
                    },
                },
            },
        }));
}
function getExistingIpAddress() {
    return envoyConfig.static_resources.clusters[0].load_assignment.endpoints[0].lb_endpoints.map(
        (item: any) => item.endpoint.address.socket_address.address
    );
}
