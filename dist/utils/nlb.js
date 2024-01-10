"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.removeMasterIpAddressesFromLoadBalancer = exports.addMasterIpAddressesToLoadBalancer = exports.getTargetGroupIpAddresses = void 0;
const config_1 = require("./config");
const client_elastic_load_balancing_v2_1 = require("@aws-sdk/client-elastic-load-balancing-v2");
const elb = new client_elastic_load_balancing_v2_1.ElasticLoadBalancingV2(config_1.clusterFiles.credentials);
async function getTargetGroupIpAddresses() {
    const { TargetHealthDescriptions } = await elb.describeTargetHealth({
        TargetGroupArn: config_1.clusterFiles.targetGroup,
    });
    if (!TargetHealthDescriptions?.length)
        return [];
    return TargetHealthDescriptions.reduce((final, { Target }) => {
        if (!Target?.Id)
            return final;
        if (!final.includes(Target.Id))
            final.push(Target.Id);
        return final;
    }, []);
}
exports.getTargetGroupIpAddresses = getTargetGroupIpAddresses;
async function addMasterIpAddressesToLoadBalancer(ipAddresses) {
    await elb.registerTargets({
        TargetGroupArn: config_1.clusterFiles.targetGroup,
        Targets: ipAddresses.map((ipAddress) => ({
            Id: ipAddress,
            Port: 6379,
        })),
    });
}
exports.addMasterIpAddressesToLoadBalancer = addMasterIpAddressesToLoadBalancer;
async function removeMasterIpAddressesFromLoadBalancer(ipAddresses) {
    await elb.deregisterTargets({
        TargetGroupArn: config_1.clusterFiles.targetGroup,
        Targets: ipAddresses.map((ipAddress) => ({
            Id: ipAddress,
            Port: 6379,
        })),
    });
}
exports.removeMasterIpAddressesFromLoadBalancer = removeMasterIpAddressesFromLoadBalancer;
