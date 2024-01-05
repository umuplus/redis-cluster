"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getInstances = void 0;
const config_1 = require("./config");
const client_ec2_1 = require("@aws-sdk/client-ec2");
const instanceName = 'RedisClusterNode';
async function getInstances() {
    const ec2 = new client_ec2_1.EC2(config_1.clusterFiles.credentials);
    const { Reservations } = await ec2.describeInstances({
        Filters: [
            { Name: 'instance-state-name', Values: ['running'] },
            { Name: 'tag:Name', Values: [instanceName] },
        ],
    });
    if (!Reservations?.length)
        return [];
    return Reservations.reduce((final, current) => {
        if (current.Instances?.length)
            for (let instance of current.Instances)
                if (instance.PrivateIpAddress && !final.includes(instance.PrivateIpAddress))
                    final.push(instance.PrivateIpAddress);
        return final;
    }, []);
}
exports.getInstances = getInstances;
