import { AutoScaling, AutoScalingGroup } from '@aws-sdk/client-auto-scaling';
import { clusterFiles } from './config';
import { EC2, Instance } from '@aws-sdk/client-ec2';

const AUTO_SCALING_GROUP_NAME = 'RedisASG';

async function getAutoScalingGroup() {
    const autoScaling = new AutoScaling(clusterFiles.credentials);
    const result = await autoScaling.describeAutoScalingGroups({
        AutoScalingGroupNames: [AUTO_SCALING_GROUP_NAME],
    });
    autoScaling.destroy();
    return result.AutoScalingGroups?.[0];
}

export async function getInstances(instanceIds: string[]) {
    if (!instanceIds.length) return {};

    const ec2 = new EC2(clusterFiles.credentials);
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
