export type RedisClusterNode = {
    id: string;
    ip: string;
    master: boolean;
    healthy: boolean;
    shards: string[];
};

export function parseRedisNodes(payload: string) {
    const nodes = payload.split('\n');
    return nodes.reduce((final: Record<string, RedisClusterNode>, node) => {
        const [id, ipAddress, _flags, masterId, _ping, _pong, _epoch, status, shards] =
            node.split(' ');
        const [ip] = ipAddress.split(':');
        final[ip] = {
            id,
            ip,
            master: masterId === '-',
            healthy: status === 'connected',
            shards: shards
                .trim()
                .split('-')
                .filter((shard) => shard),
        };
        return final;
    }, {});
}
