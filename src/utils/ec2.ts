import { clusterFiles } from './config';
import { EC2, Instance } from '@aws-sdk/client-ec2';

const instanceName = 'RedisClusterNode';

export async function getInstances(): Promise<Instance[]> {
    const ec2 = new EC2(clusterFiles.credentials);
    const { Reservations } = await ec2.describeInstances({
        Filters: [
            { Name: 'instance-state-name', Values: ['running'] },
            { Name: 'tag:Name', Values: [`${instanceName}*`] },
        ],
    });
    if (!Reservations?.length) return [];

    return Reservations.reduce((final: Instance[], current) => {
        if (current.Instances?.length)
            for (let instance of current.Instances)
                if (
                    instance.PublicIpAddress &&
                    !final.find((i) => i.PublicIpAddress === instance.PublicIpAddress)
                )
                    final.push(instance);
        return final;
    }, []);
}
