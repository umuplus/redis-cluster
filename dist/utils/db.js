"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getOwnerNodeIP = exports.putOwnerNodeIP = void 0;
const config_1 = require("./config");
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const lib_dynamodb_1 = require("@aws-sdk/lib-dynamodb");
const TableName = 'RedisClusterTable';
const ddb = lib_dynamodb_1.DynamoDBDocumentClient.from(new client_dynamodb_1.DynamoDB(config_1.clusterFiles.credentials));
async function putOwnerNodeIP(ip, takeOverFrom = 'N/A') {
    console.log('saving owner node ip to db');
    await ddb.send(new lib_dynamodb_1.PutCommand({
        TableName,
        Item: { pk: 'OWNER', val: ip },
        ConditionExpression: 'attribute_not_exists(pk) OR val = :t',
        ExpressionAttributeValues: { ':t': takeOverFrom },
    }));
}
exports.putOwnerNodeIP = putOwnerNodeIP;
async function getOwnerNodeIP() {
    try {
        const result = await ddb.send(new lib_dynamodb_1.GetCommand({ TableName, Key: { pk: 'OWNER' } }));
        return result.Item?.val;
    }
    catch (e) {
        return undefined;
    }
}
exports.getOwnerNodeIP = getOwnerNodeIP;
