import yaml from 'yaml';
import { clusterFiles } from './config';
import { execSync } from 'child_process';
import { getInstanceIds, getInstances } from './asg';
import { join as joinPath } from 'path';
import { parseRedisNodes } from './redis';
import { writeFileSync } from 'fs';

const envoyConfigPath = joinPath(__dirname, '..', '..', 'config', 'envoy.yaml');
const envoyConfig = yaml.parse(envoyConfigPath);
envoyConfig.static_resources.clusters[0].load_assignment.endpoints[0].lb_endpoints = [];

export async function checkRedisClusterProxy() {
    try {
        const instanceIds = await getInstanceIds();
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
        if (masterNodeIps.length) {
            const existingIps = getExistingIpAddress();
            configureEnvoy(masterNodeIps);
            if (existingIps.join(',') !== masterNodeIps.join(',')) {
                const tmpEnvoyConfigPath = `/tmp/envoy-config-${Date.now()}.yaml`;
                writeFileSync(tmpEnvoyConfigPath, yaml.stringify(envoyConfig));
                execSync(`sudo cp ${tmpEnvoyConfigPath} ${envoyConfigPath}`);
                execSync('sudo service envoy restart');
                execSync(`rm -rf ${tmpEnvoyConfigPath}`);
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
