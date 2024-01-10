import { clusterFiles } from './config';
import {
    ElasticLoadBalancingV2,
    TargetHealthStateEnum,
} from '@aws-sdk/client-elastic-load-balancing-v2';

const elb = new ElasticLoadBalancingV2(clusterFiles.credentials);

export async function getTargetGroupIpAddresses() {
    const { TargetHealthDescriptions } = await elb.describeTargetHealth({
        TargetGroupArn: clusterFiles.targetGroup,
    });

    if (!TargetHealthDescriptions?.length) return [];

    return TargetHealthDescriptions.reduce((final: string[], { Target }) => {
        if (!Target?.Id) return final;

        if (!final.includes(Target.Id)) final.push(Target.Id);
        return final;
    }, []);
}

export async function addMasterIpAddressesToLoadBalancer(ipAddresses: string[]) {
    await elb.registerTargets({
        TargetGroupArn: clusterFiles.targetGroup,
        Targets: ipAddresses.map((ipAddress) => ({
            Id: ipAddress,
            Port: 6379,
        })),
    });
}

export async function removeMasterIpAddressesFromLoadBalancer(ipAddresses: string[]) {
    await elb.deregisterTargets({
        TargetGroupArn: clusterFiles.targetGroup,
        Targets: ipAddresses.map((ipAddress) => ({
            Id: ipAddress,
            Port: 6379,
        })),
    });
}
