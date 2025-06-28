const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mediasoup = require('mediasoup');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: '*' } });

let worker;
let router;
const transports = new Map(); // socketId → Transport[]
const producers = new Map();  // socketId → Producer[]
const allProducers = new Map(); // producerId → producer (전역 producer 리스트)

async function startMediasoupWorker() {
    worker = await mediasoup.createWorker();
    router = await worker.createRouter({
        mediaCodecs: [{
            kind: 'audio',
            mimeType: 'audio/opus',
            clockRate: 48000,
            channels: 2,
            parameters: {
                useinbandfec: 1,
                usedtx: 1
            }
        }]
    });
    console.log('✅ mediasoup worker created');
}

io.on('connection', (socket) => {
    console.log('🔌 client connected:', socket.id);
    transports.set(socket.id, []);
    producers.set(socket.id, []);

    socket.on('getRtpCapabilities', (callback) => {
        callback(router.rtpCapabilities);
    });

    socket.on('createWebRtcTransport', async ({ direction }, callback) => {
        try {
            const transport = await router.createWebRtcTransport({
                listenIps: [{ ip: '127.0.0.1', announcedIp: null }],
                enableUdp: true,
                enableTcp: true,
                preferUdp: true,
            });



            // ✅ ICE 상태 변경 로그
            transport.on('icestatechange', (state) => {
                console.log(`🔄 ICE state changed for transport ${transport.id}: ${state}`);
            });

            // ✅ DTLS 상태 변경 로그
            transport.on('dtlsstatechange', (state) => {
                console.log(`🔐 DTLS state changed for transport ${transport.id}: ${state}`);
            });


            transports.get(socket.id).push(transport);

            callback({
                id: transport.id,
                iceParameters: transport.iceParameters,
                iceCandidates: transport.iceCandidates,
                dtlsParameters: transport.dtlsParameters,
                iceServers: [
                    {
                        urls: 'turn:221.133.130.37:3478',
                        username: 'testuser',
                        credential: 'testpass'
                    }
                ]
            });
        } catch (err) {
            callback({ error: err.message });
        }
    });

    socket.on('connectTransport', async ({ transportId, dtlsParameters }, callback) => {
        const all = transports.get(socket.id) || [];
        const transport = all.find(t => t.id === transportId);
        if (!transport) return callback({ error: 'Transport not found' });

        try {
            await transport.connect({ dtlsParameters });
            callback('success');
        } catch (err) {
            callback({ error: err.message });
        }
    });

    socket.on('produce', async ({ transportId, kind, rtpParameters }, callback) => {
        const all = transports.get(socket.id) || [];
        const transport = all.find(t => t.id === transportId);
        if (!transport) return callback({ error: 'Transport not found' });

        try {
            const producer = await transport.produce({ kind, rtpParameters });
            producers.get(socket.id).push(producer);
            allProducers.set(producer.id, producer);
            callback({ id: producer.id });

            // ✅ RTP 패킷 전송 로그 (여기 추가!)
            producer.on('trace', (trace) => {
                if (trace.type === 'rtp') {
                    console.log(`📡 RTP packet sent for producer ${producer.id}`);
                }
            });

            socket.broadcast.emit('newProducer', { producerId: producer.id, socketId: socket.id });
            console.log(`📢 newProducer broadcasted: ${producer.id}`);
        } catch (err) {
            callback({ error: err.message });
        }
    });

    socket.on('getProducers', (callback) => {
        const list = Array.from(allProducers.keys());
        callback(list);
    });

    socket.on('consume', async ({ transportId, producerId, rtpCapabilities }, callback) => {
        const all = transports.get(socket.id) || [];
        const transport = all.find(t => t.id === transportId);
        if (!transport) return callback({ error: 'Transport not found' });

        const producer = allProducers.get(producerId);
        if (!producer) return callback({ error: 'Producer not found' });

        console.log('✅ Creating consumer for:', producerId);
        console.log('✅ Client rtpCapabilities:', rtpCapabilities.codecs.map(c => c.mimeType));

        try {
            const consumer = await transport.consume({
                producerId,
                rtpCapabilities,
                paused: false,
            });
            console.log('✅ Consumer created:', consumer.id);
            callback({
                id: consumer.id,
                producerId: producerId,
                kind: consumer.kind,
                rtpParameters: consumer.rtpParameters,
            });
        } catch (err) {
            console.error('❌ Consume error:', err);
            callback({ error: err.message });
        }
    });

    socket.on('disconnect', () => {
        console.log('❌ client disconnected:', socket.id);

        const prods = producers.get(socket.id) || [];
        prods.forEach(p => {
            allProducers.delete(p.id);
            p.close();
        });
        producers.delete(socket.id);

        const trans = transports.get(socket.id) || [];
        trans.forEach(t => t.close());
        transports.delete(socket.id);
    });
});

server.listen(4000, () => console.log('🚀 Server listening on port 4000'));
startMediasoupWorker();
