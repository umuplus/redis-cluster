"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parsePM2Usage = exports.getEC2Details = exports.getInstanceIds = exports.getInstances = void 0;
const axios_1 = __importDefault(require("axios"));
const check_disk_space_1 = __importDefault(require("check-disk-space"));
const client_auto_scaling_1 = require("@aws-sdk/client-auto-scaling");
const config_1 = require("./config");
const os_1 = require("os");
const client_ec2_1 = require("@aws-sdk/client-ec2");
const AUTO_SCALING_GROUP_NAME = 'RedisASG';
const autoScaling = new client_auto_scaling_1.AutoScaling(config_1.clusterFiles.credentials);
const ec2 = new client_ec2_1.EC2(config_1.clusterFiles.credentials);
async function getAutoScalingGroup() {
    const result = await autoScaling.describeAutoScalingGroups({
        AutoScalingGroupNames: [AUTO_SCALING_GROUP_NAME],
    });
    autoScaling.destroy();
    return result.AutoScalingGroups?.[0];
}
async function getInstances(instanceIds) {
    if (!instanceIds.length)
        return {};
    const { Reservations } = await ec2.describeInstances({ InstanceIds: instanceIds });
    if (!Reservations?.length)
        return {};
    return Reservations.reduce((final, current) => {
        if (current.Instances?.length)
            final.push(...current.Instances);
        return final;
    }, []).reduce((final, current) => {
        if (current.InstanceId)
            final[current.InstanceId] = current;
        return final;
    }, {});
}
exports.getInstances = getInstances;
async function getInstanceIds(asg) {
    if (!asg)
        asg = await getAutoScalingGroup();
    if (!asg || !asg.DesiredCapacity || !asg.Instances?.length) {
        if (!asg)
            throw new Error(`Auto scaling group not found!`);
        else if (!asg.DesiredCapacity)
            throw new Error(`Auto scaling group is disabled.`);
        else
            throw new Error(`No instances found in the auto scaling group.`);
    }
    const capacity = asg.DesiredCapacity || 0;
    const instanceIds = asg.Instances.filter((instance) => instance.LifecycleState === 'InService' && instance.InstanceId).map((instance) => instance.InstanceId);
    const instanceCount = instanceIds.length || 0;
    if (instanceCount < capacity)
        throw new Error(`There are only ${instanceCount}/${capacity} instances available.`);
    return instanceIds;
}
exports.getInstanceIds = getInstanceIds;
let instanceId;
let privateIp;
let publicIp;
async function getEC2Details() {
    if (!instanceId)
        instanceId = await axios_1.default
            .get('http://169.254.169.254/latest/meta-data/instance-type', {
            headers: { 'Content-Type': 'text/plain' },
        })
            .then((res) => res.data)
            .catch(() => undefined);
    if (!privateIp)
        privateIp = await axios_1.default
            .get('http://169.254.169.254/latest/meta-data/local-ipv4', {
            headers: { 'Content-Type': 'text/plain' },
        })
            .then((res) => res.data)
            .catch(() => undefined);
    if (!publicIp)
        publicIp = await axios_1.default
            .get('http://169.254.169.254/latest/meta-data/public-ipv4', {
            headers: { 'Content-Type': 'text/plain' },
        })
            .then((res) => res.data)
            .catch(() => undefined);
    return {
        instanceId,
        privateIp,
        publicIp,
        cpus: (0, os_1.cpus)(),
        memory: { total: (0, os_1.totalmem)(), free: (0, os_1.freemem)() },
        disk: await (0, check_disk_space_1.default)(process.env.HOME).catch(() => undefined),
    };
}
exports.getEC2Details = getEC2Details;
function parsePM2Usage(payload) {
    for (const line of payload.split('\n')) {
        if (!line || !line.includes('│'))
            continue;
        const [id, name, _namespace, version, mode, pid, uptime, restart, status, cpu, memory] = line
            .split('│')
            .map((i) => i.trim())
            .filter((i) => i);
        if (id === process.env.NODE_APP_INSTANCE) {
            return {
                id,
                name,
                version,
                mode,
                pid,
                uptime,
                restart,
                status,
                cpu,
                memory,
            };
        }
    }
    return undefined;
}
exports.parsePM2Usage = parsePM2Usage;
