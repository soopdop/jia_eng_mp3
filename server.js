const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = __dirname;

// MIME 타입 매핑
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

// URL의 최종 리다이렉트 목적지를 0.05초 만에 추적하는 함수 (최대 5회 추적)
function resolveFinalUrl(targetUrl, maxHops = 5) {
  return new Promise((resolve, reject) => {
    if (maxHops <= 0) return resolve(targetUrl);

    try {
      const parsed = new URL(targetUrl);
      const client = parsed.protocol === 'https:' ? https : http;

      const req = client.request(parsed, {
        method: 'HEAD',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
          'Accept': '*/*'
        }
      }, (res) => {
        // 301, 302, 307, 308 리다이렉트 헤더 낚아채기
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          const redirectLocation = new URL(res.headers.location, targetUrl).href;
          req.destroy();
          resolveFinalUrl(redirectLocation, maxHops - 1).then(resolve).catch(reject);
        } else {
          req.destroy();
          resolve(targetUrl);
        }
      });

      req.on('error', () => {
        // HEAD 실패 시 GET으로 1회 재시도 (일부 서버가 HEAD를 거부하는 경우 대비)
        const getReq = client.request(parsed, {
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
            'Range': 'bytes=0-0'
          }
        }, (res) => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
            const redirectLocation = new URL(res.headers.location, targetUrl).href;
            getReq.destroy();
            resolveFinalUrl(redirectLocation, maxHops - 1).then(resolve).catch(reject);
          } else {
            getReq.destroy();
            resolve(targetUrl);
          }
        });
        getReq.on('error', () => resolve(targetUrl));
        getReq.setTimeout(4000, () => { getReq.destroy(); resolve(targetUrl); });
        getReq.end();
      });

      req.setTimeout(4000, () => { req.destroy(); resolve(targetUrl); });
      req.end();
    } catch (e) {
      resolve(targetUrl);
    }
  });
}

// 오디오 스트림 프록시 함수 (CORS가 막힌 음원도 서버가 받아서 브라우저로 중계)
function proxyAudio(targetUrl, clientReq, clientRes) {
  try {
    const parsed = new URL(targetUrl);
    const client = parsed.protocol === 'https:' ? https : http;

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      'Accept': '*/*',
    };
    if (clientReq.headers.range) {
      headers['Range'] = clientReq.headers.range;
    }

    const proxyReq = client.request(parsed, { method: 'GET', headers }, (proxyRes) => {
      // 리다이렉트 응답이면 따라가기
      if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode) && proxyRes.headers.location) {
        const nextUrl = new URL(proxyRes.headers.location, targetUrl).href;
        return proxyAudio(nextUrl, clientReq, clientRes);
      }

      const responseHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Range, Content-Type',
        'Content-Type': proxyRes.headers['content-type'] || 'audio/mpeg',
      };
      if (proxyRes.headers['content-length']) responseHeaders['Content-Length'] = proxyRes.headers['content-length'];
      if (proxyRes.headers['content-range']) responseHeaders['Content-Range'] = proxyRes.headers['content-range'];
      if (proxyRes.headers['accept-ranges']) responseHeaders['Accept-Ranges'] = proxyRes.headers['accept-ranges'];

      clientRes.writeHead(proxyRes.statusCode, responseHeaders);
      proxyRes.pipe(clientRes);
    });

    proxyReq.on('error', (err) => {
      clientRes.writeHead(502, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({ error: '오디오 프록시 실패', detail: err.message }));
    });

    proxyReq.end();
  } catch (err) {
    clientRes.writeHead(400, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({ error: '잘못된 URL 규격입니다.' }));
  }
}

// HTTP 서버 인스턴스 생성
const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = reqUrl.pathname;

  // CORS 프리플라이트 대응
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Range'
    });
    return res.end();
  }

  // 1. 단축 URL 리다이렉트 해석 API: /api/resolve?url=http://ne2.us/...
  if (pathname === '/api/resolve') {
    const rawTarget = reqUrl.searchParams.get('url');
    if (!rawTarget) {
      res.writeHead(400, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'url 파라미터가 필요합니다.' }));
    }

    try {
      const finalUrl = await resolveFinalUrl(rawTarget);
      res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ originalUrl: rawTarget, finalUrl: finalUrl }));
    } catch (e) {
      res.writeHead(500, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ originalUrl: rawTarget, finalUrl: rawTarget, error: e.message }));
    }
    return;
  }

  // 2. 오디오 중계 프록시 API: /api/proxy?url=...
  if (pathname === '/api/proxy') {
    const rawTarget = reqUrl.searchParams.get('url');
    if (!rawTarget) {
      res.writeHead(400, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'url 파라미터가 필요합니다.' }));
    }
    return proxyAudio(rawTarget, req, res);
  }

  // 3. 정적 웹 파일 서빙 (index.html, jia2.png, favicon.png, icon-192.png)
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // 404 발생 시 index.html로 fallback
      filePath = path.join(PUBLIC_DIR, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*'
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`===============================================`);
  console.log(`🎧 지아의 영어 문장 쏙쏙 듣기 서버 시작 완료!`);
  console.log(`👉 로컬 접속: http://localhost:${PORT}`);
  console.log(`👉 단축 URL 해석 API: http://localhost:${PORT}/api/resolve?url=...`);
  console.log(`===============================================`);
});
