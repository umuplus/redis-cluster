export type RedisClusterNode = {
    id: string;
    ip: string;
    master: boolean;
    healthy: boolean;
    slaveOf?: string;
    slaves: string[];
};

export function parseRedisNodes(payload: string) {
    const rawNodes = payload.split('\n').filter((node) => node?.trim());
    const nodes = rawNodes.reduce((final: Record<string, RedisClusterNode>, node) => {
        if (node.startsWith('Warning')) return final;

        const [id, ipAddress, flags, masterId, _ping, _pong, _epoch, status] = node.split(' ');
        const [ip] = ipAddress.split(':');
        const master = masterId === '-';
        final[ip] = {
            id,
            ip,
            master,
            healthy: status === 'connected' && !flags.includes('fail'),
            slaveOf: master ? undefined : masterId,
            slaves: [],
        };
        return final;
    }, {});
    const ips = Object.keys(nodes)
    for (const ip of ips) {
        const node = nodes[ip];
        if (node.master) continue;

        const masterOfTheNodeIp = ips.find(i => nodes[i].id === node.slaveOf);
        if (!masterOfTheNodeIp) continue;

        nodes[masterOfTheNodeIp].slaves.push(node.id);
    }
    return nodes;
}
