"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getInstanceIds = exports.getInstances = void 0;
const client_auto_scaling_1 = require("@aws-sdk/client-auto-scaling");
const config_1 = require("./config");
const client_ec2_1 = require("@aws-sdk/client-ec2");
const AUTO_SCALING_GROUP_NAME = 'RedisASG';
async function getAutoScalingGroup() {
    const autoScaling = new client_auto_scaling_1.AutoScaling(config_1.clusterFiles.credentials);
    const result = await autoScaling.describeAutoScalingGroups({
        AutoScalingGroupNames: [AUTO_SCALING_GROUP_NAME],
    });
    autoScaling.destroy();
    return result.AutoScalingGroups?.[0];
}
async function getInstances(instanceIds) {
    if (!instanceIds.length)
        return {};
    const ec2 = new client_ec2_1.EC2(config_1.clusterFiles.credentials);
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
