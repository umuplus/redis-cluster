import axios from 'axios';
import checkDiskSpace from 'check-disk-space';
import { AutoScaling, AutoScalingGroup } from '@aws-sdk/client-auto-scaling';
import { clusterFiles } from './config';
import { cpus, freemem, totalmem } from 'os';
import { EC2, Instance } from '@aws-sdk/client-ec2';

const AUTO_SCALING_GROUP_NAME = 'RedisASG';

const autoScaling = new AutoScaling(clusterFiles.credentials);
const ec2 = new EC2(clusterFiles.credentials);

async function getAutoScalingGroup() {
    const result = await autoScaling.describeAutoScalingGroups({
        AutoScalingGroupNames: [AUTO_SCALING_GROUP_NAME],
    });
    autoScaling.destroy();
    return result.AutoScalingGroups?.[0];
}

export async function getInstances(instanceIds: string[]) {
    if (!instanceIds.length) return {};

    const { Reservations } = await ec2.describeInstances({ InstanceIds: instanceIds });
    if (!Reservations?.length) return {};

    return Reservations.reduce((final: Instance[], current) => {
        if (current.Instances?.length) final.push(...current.Instances);
        return final;
    }, []).reduce((final: Record<string, Instance>, current) => {
        if (current.InstanceId) final[current.InstanceId] = current;
        return final;
    }, {});
}

export async function getInstanceIds(asg?: AutoScalingGroup) {
    if (!asg) asg = await getAutoScalingGroup();
    if (!asg || !asg.DesiredCapacity || !asg.Instances?.length) {
        if (!asg) throw new Error(`Auto scaling group not found!`);
        else if (!asg.DesiredCapacity) throw new Error(`Auto scaling group is disabled.`);
        else throw new Error(`No instances found in the auto scaling group.`);
    }

    const capacity = asg.DesiredCapacity || 0;
    const instanceIds = asg.Instances.filter(
        (instance) => instance.LifecycleState === 'InService' && instance.InstanceId
    ).map((instance) => instance.InstanceId as string)!;
    const instanceCount = instanceIds.length || 0;
    if (instanceCount < capacity)
        throw new Error(`There are only ${instanceCount}/${capacity} instances available.`);

    return instanceIds;
}

let instanceType: string | undefined;
let privateIp: string | undefined;
let publicIp: string | undefined;

export async function getEC2Details() {
    if (!instanceType)
        instanceType = await axios
            .get('http://169.254.169.254/latest/meta-data/instance-type', {
                headers: { 'Content-Type': 'text/plain' },
            })
            .then((res) => res.data)
            .catch(() => undefined);

    if (!privateIp)
        privateIp = await axios
            .get('http://169.254.169.254/latest/meta-data/local-ipv4', {
                headers: { 'Content-Type': 'text/plain' },
            })
            .then((res) => res.data)
            .catch(() => undefined);

    if (!publicIp)
        publicIp = await axios
            .get('http://169.254.169.254/latest/meta-data/public-ipv4', {
                headers: { 'Content-Type': 'text/plain' },
            })
            .then((res) => res.data)
            .catch(() => undefined);

    return {
        instanceType,
        privateIp,
        publicIp,
        cpus: cpus(),
        memory: { total: totalmem(), free: freemem() },
        disk: await checkDiskSpace(process.env.HOME!).catch(() => undefined),
        key: publicIp,
        updatedAt: new Date().toISOString(),
    };
}

export function parsePM2Usage(payload: string) {

    for (const line of payload.split('\n')) {
        if (!line || !line.includes('│')) continue;

        const [id, name, _namespace, version, mode, pid, uptime, restart, status, cpu, memory] =
            line
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
                key: `${publicIp}-${pid}-${process.env.NODE_APP_INSTANCE}`,
                updatedAt: new Date().toISOString(),
            };
        }
    }

    return undefined;
}
