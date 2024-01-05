"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkRedisClusterProxy = void 0;
const yaml_1 = __importDefault(require("yaml"));
const config_1 = require("./config");
const child_process_1 = require("child_process");
const asg_1 = require("./asg");
const path_1 = require("path");
const redis_1 = require("./redis");
const fs_1 = require("fs");
const envoyConfigPath = (0, path_1.join)(__dirname, '..', '..', 'config', 'envoy.yaml');
const envoyConfig = yaml_1.default.parse((0, fs_1.readFileSync)(envoyConfigPath, 'utf-8'));
envoyConfig.static_resources.clusters[0].load_assignment.endpoints[0].lb_endpoints = [];
async function checkRedisClusterProxy() {
    try {
        const asg = await (0, asg_1.getCacheAutoScalingGroup)();
        if (!asg)
            throw new Error(`Auto scaling group not found for cache nodes.`);
        const instanceIds = await (0, asg_1.getInstanceIds)(asg);
        const instances = await (0, asg_1.getInstances)([instanceIds[0]]);
        const instance = Object.values(instances)[0];
        const clusterNodesCommand = `redis-cli -h ${instance.PrivateIpAddress} -a ${config_1.clusterFiles.password} cluster nodes`;
        console.log('>', clusterNodesCommand);
        const nodesRaw = (0, child_process_1.execSync)(clusterNodesCommand).toString();
        console.log('>', nodesRaw);
        const nodes = (0, redis_1.parseRedisNodes)(nodesRaw);
        const masterNodeIps = Object.values(nodes)
            .filter(({ master }) => master)
            .map(({ ip }) => ip)
            .sort();
        console.log('master node(s) :', masterNodeIps.join(','));
        if (masterNodeIps.length) {
            const existingIps = getExistingIpAddress();
            configureEnvoy(masterNodeIps);
            if (existingIps.join(',') !== masterNodeIps.join(',')) {
                (0, fs_1.writeFileSync)(envoyConfigPath, yaml_1.default.stringify(envoyConfig));
                const checkIfEnvoyRunning = `ps aux | grep envoy | grep -v grep | awk '{print $2}'`;
                console.log('>', checkIfEnvoyRunning);
                const envoyRunning = (0, child_process_1.execSync)(checkIfEnvoyRunning).toString();
                if (envoyRunning) {
                    const killEnvoy = `pkill -9 envoy`;
                    console.log('>', killEnvoy);
                    (0, child_process_1.execSync)(killEnvoy);
                }
                (0, child_process_1.spawn)('envoy', [`-c ${envoyConfigPath}`], { detached: true, stdio: 'ignore' });
            }
        }
    }
    catch (e) {
        console.log(e);
        console.error(e.message);
    }
}
exports.checkRedisClusterProxy = checkRedisClusterProxy;
function configureEnvoy(ipAddresses) {
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
    return envoyConfig.static_resources.clusters[0].load_assignment.endpoints[0].lb_endpoints.map((item) => item.endpoint.address.socket_address.address);
}
