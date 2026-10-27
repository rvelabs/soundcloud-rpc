const https = require('node:https'),
    http = require('node:http'),
    net = require('node:net'),
    fs = require('node:fs'),
    path = require('node:path');
const { execFileSync } = require('node:child_process');
const { X509Certificate } = require('node:crypto');
exports.createHttpsFixture = async (folder, hosts, handler) => {
    fs.mkdirSync(folder, { recursive: true });
    const keyFile = path.join(folder, 'fixture.key'),
        certFile = path.join(folder, 'fixture.crt');
    execFileSync(
        process.env.OPENSSL_PATH || 'C:/Program Files/Git/usr/bin/openssl.exe',
        [
            'req',
            '-x509',
            '-newkey',
            'rsa:2048',
            '-noenc',
            '-keyout',
            keyFile,
            '-out',
            certFile,
            '-days',
            '1',
            '-subj',
            '/CN=' + hosts[0],
            '-addext',
            'subjectAltName=' + hosts.map((host) => 'DNS:' + host).join(','),
        ],
        { stdio: 'ignore', windowsHide: true },
    );
    const cert = fs.readFileSync(certFile),
        pinned = new X509Certificate(cert),
        sockets = new Set();
    const server = https.createServer({ cert, key: fs.readFileSync(keyFile) }, handler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const proxy = http.createServer();
    proxy.on('connect', (request, socket, head) => {
        if (!hosts.some((host) => request.url === host + ':443')) {
            socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
            return;
        }
        const upstream = net.connect(server.address().port, '127.0.0.1', () => {
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head.length) upstream.write(head);
            socket.pipe(upstream);
            upstream.pipe(socket);
        });
        for (const item of [socket, upstream]) {
            sockets.add(item);
            item.on('close', () => sockets.delete(item));
            item.on('error', () => {
                socket.destroy();
                upstream.destroy();
            });
        }
    });
    await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    return {
        async apply(target) {
            target.setCertificateVerifyProc((request, done) => {
                try {
                    done(
                        hosts.includes(request.hostname) &&
                            new X509Certificate(request.certificate.data).raw.equals(pinned.raw)
                            ? 0
                            : -3,
                    );
                } catch {
                    done(-3);
                }
            });
            await target.setProxy({ mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:' + proxy.address().port });
        },
        close() {
            for (const socket of sockets) socket.destroy();
            proxy.close();
            server.close();
        },
    };
};
