const fs = require('fs');
const path = require('path');

// --- 1. 源列表配置 ---
const TASKS = [
  { url: "https://live.lizanyang.top/hn.m3u", ua: "Mozilla/5.0" },
  { url: "https://itv.aptv.app/china-iptv/hnyd.m3u", ua: "AptvPlayer/1.2.5(iPhone)" },
  { url: "https://itv.5iclub.dpdns.org/MiGu.m3u", ua: "AptvPlayer/1.2.5(iPhone)" },
  { url: "http://82.156.243.185:33389/fwc.m3u", ua: "AptvPlayer/1.2.5(iPhone)" },
  { url: "ss.m3u", local: true },
  { url: "https://raw.githubusercontent.com/develop202/migu_video/refs/heads/main/interface.txt", ua: "Mozilla/5.0" },
  { url: "https://bit.ly/iptv-aptv", ua: "Mozilla/5.0" },
  { url: "https://live.445569.xyz/live.m3u", ua: "Mozilla/5.0" },
  { url: "https://develop202.github.io/migu_video/interface.txt", ua: "Mozilla/5.0" },
  { url: "https://bit.ly/itvlist", ua: "Mozilla/5.0" },
  { url: "https://bit.ly/suxuang-v4", ua: "Mozilla/5.0" },
  { url: "https://raw.githubusercontent.com/suxuang/myIPTV/main/ipv4.m3u", ua: "Mozilla/5.0" }
];

// --- 2. 填写合并后的 EPG 链接 ---
const CUSTOM_EPG = "https://kan.935999.xyz/epg.xml";

// --- 3. 引入独立的配置 ---
const ALIAS_MAP = require('./alias.js');
const BLOCK_LIST = require('./blocklist.js');

// --- 4. 读取外部的 template.txt 文件 ---
const TEMPLATE = fs.readFileSync(path.join(__dirname, 'template.txt'), 'utf-8');

// --- 5. 腾讯云函数探测配置 ---
const TENCENT_API_URL = "https://tvapi.dayucg.com";
const SECRET_TOKEN = "DayuCG-IPTV-2026"; 

// --- 6. 解析模板并构建数据结构 ---
const templateChannels = new Map(); 

function initTemplate() {
  let currentGroup = '未分类';
  const lines = TEMPLATE.split('\n');
  
  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith('//')) continue;
    
    if (line.startsWith('#')) {
      currentGroup = line.substring(1).trim(); 
    } else {
      let key = line.toLowerCase().replace(/[-_  ]/g, '');
      templateChannels.set(key, { 
        name: line,         
        group: currentGroup,
        id: '',             
        logo: '',           
        urls: new Set()     
      });
    }
  }
}

// --- 7. 智能匹配源频道名到模板频道名 ---
function matchChannel(m3uChannelName) {
  let clean = m3uChannelName.toLowerCase().replace(/[-_  ]/g, '');
  
  for (const [standard, aliases] of Object.entries(ALIAS_MAP)) {
    if (clean.includes(standard) || aliases.some(alias => clean.includes(alias))) {
      clean = standard;
      break;
    }
  }

  if (templateChannels.has(clean)) return clean;
  
  let cleanNoSuffix = clean.replace(/hd|fhd|1080p|1080i|720p|超清|高清/g, '');
  if (templateChannels.has(cleanNoSuffix)) return cleanNoSuffix;
  
  for (const key of templateChannels.keys()) {
    if (clean.startsWith(key) || cleanNoSuffix.startsWith(key)) {
      if (key.match(/cctv\d+$/) && clean.match(new RegExp(`^${key}\\d`))) continue;
      return key;
    }
  }
  return null;
}

// --- 8. 黑名单检测 ---
function isBlocked(url) {
  return BLOCK_LIST.some(keyword => url.includes(keyword));
}

// --- 9. 带有超时的 Fetch 封装 (防止 GitHub Actions 卡死) ---
async function fetchWithTimeout(resource, options = {}) {
  const { timeout = 15000 } = options;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  const response = await fetch(resource, {
    ...options,
    signal: controller.signal  
  });
  clearTimeout(id);
  return response;
}

// --- 10. 调用腾讯云函数进行探测 ---
async function probeUrls(urlArray) {
    if (!urlArray || urlArray.length === 0) return [];
    try {
        const response = await fetch(TENCENT_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: SECRET_TOKEN, urls: urlArray })
        });

        if (!response.ok) {
            console.error(`❌ 云函数返回异常状态码: ${response.status}`);
            return urlArray; // 降级：原样返回
        }

        const data = await response.json();
        return data.aliveUrls || [];
    } catch (error) {
        console.error("❌ 请求云函数报错:", error.message);
        return urlArray; // 降级：如果网络不通，保留原链接以防清空文件
    }
}

// --- 11. 核心业务逻辑 ---
async function main() {
  console.log(`🚀 开始执行抓取任务...`);
  initTemplate();
  const globalEpgUrls = new Set(); 
  let blockedCount = 0; 
  
  if (CUSTOM_EPG) {
    CUSTOM_EPG.split(',').forEach(url => globalEpgUrls.add(url.trim()));
  }

  // ★ 优化1：并行抓取所有源
  const fetchPromises = TASKS.map(async (task) => {
    try {
      let text = '';
      if (task.local) {
        let localPath = path.join(__dirname, task.url);
        if (!fs.existsSync(localPath)) {
          localPath = path.join(__dirname, '..', task.url); 
        }
        if (!fs.existsSync(localPath)) {
          console.error(`❌ 找不到本地文件: ${localPath}`);
          return;
        }
        text = fs.readFileSync(localPath, 'utf-8');
        console.log(`✅ 本地文件读取成功: ${localPath}`);
      } else {
        const res = await fetchWithTimeout(task.url, { headers: { "User-Agent": task.ua } });
        if (!res.ok) throw new Error(`状态码 ${res.status}`);
        text = await res.text();
        console.log(`✅ 抓取成功: ${task.url}`);
      }
      return text;
    } catch (e) {
      console.error(`❌ 抓取失败 [${task.url}]:`, e.message);
      return null;
    }
  });

  const results = await Promise.all(fetchPromises);

  // 解析并聚合链接
  results.forEach(text => {
    if (!text) return;
    const lines = text.split('\n');
    let currentExtInf = '';
    let matchedKey = null;
    
    for (let line of lines) {
      line = line.trim();
      if (!line) continue;
      
      if (line.startsWith('#EXTM3U')) {
        let epgMatch = line.match(/x-tvg-url="([^"]+)"/i);
        if (epgMatch) epgMatch[1].split(',').forEach(url => globalEpgUrls.add(url.trim()));
        continue;
      }
      
      if (line.startsWith('#EXTINF')) {
        currentExtInf = line;
        let m3uName = line.substring(line.lastIndexOf(',') + 1).trim();
        matchedKey = matchChannel(m3uName);
        
        if (matchedKey) {
          let channelObj = templateChannels.get(matchedKey);
          let logoMatch = currentExtInf.match(/tvg-logo="([^"]+)"/i);
          if (logoMatch && !channelObj.logo) channelObj.logo = logoMatch[1];
          let idMatch = currentExtInf.match(/tvg-id="([^"]+)"/i);
          if (idMatch && !channelObj.id) channelObj.id = idMatch[1];
        }
      } 
      else if ((line.startsWith('http') || line.startsWith('rtmp') || line.startsWith('rtsp')) && matchedKey && currentExtInf) {
        if (isBlocked(line)) { blockedCount++; } else { templateChannels.get(matchedKey).urls.add(line); }
        currentExtInf = '';
        matchedKey = null;
      }
      else if (line.includes(',') && !line.startsWith('#EXTINF')) {
        let parts = line.split(',');
        if (parts.length >= 2) {
          let txtName = parts[0].trim();
          let txtUrls = parts[1].trim();
          if (txtUrls === '#genre#') continue; 
          
          matchedKey = matchChannel(txtName);
          if (matchedKey) {
            txtUrls.split('#').forEach(u => {
              let pureUrl = u.split('$')[0].trim(); 
              if (pureUrl.startsWith('http') || pureUrl.startsWith('rtmp') || pureUrl.startsWith('rtsp')) {
                if (isBlocked(pureUrl)) { blockedCount++; } else { templateChannels.get(matchedKey).urls.add(pureUrl); }
              }
            });
            matchedKey = null; 
          }
        }
      }
    }
  });

  // ★ 优化2：提取候选 URL 并进行分块云端探测
  console.log(`\n🔍 开始进行云端可用性探测...`);
  const allCandidateUrls = [];
  const channelUrlMap = new Map(); 

  for (const [key, info] of templateChannels.entries()) {
    if (info.urls.size === 0) continue;
    const candidates = Array.from(info.urls).slice(0, 8); 
    channelUrlMap.set(key, candidates);
    allCandidateUrls.push(...candidates);
  }

  const CHUNK_SIZE = 50; 
  const validUrlsSet = new Set();
  const urlsToProbe = [];

  // ★ 核心优化：对专网/运营商专属域名（如河南移动 CDN 等本地能看但云端无法测活的源）直接豁免放行
  for (const url of allCandidateUrls) {
    if (url.includes('chinamobile.com') || url.includes('hnyd') || url.includes('telecom')) {
      validUrlsSet.add(url); // 直接强制标记为存活，不经过云函数测活
    } else {
      urlsToProbe.push(url); // 其他公共源正常送往云函数测活
    }
  }

  // 对剩下需要测活的公共源分块发送
  for (let i = 0; i < urlsToProbe.length; i += CHUNK_SIZE) {
    const chunk = urlsToProbe.slice(i, i + CHUNK_SIZE);
    console.log(`正在探测第 ${i + 1} 到 ${Math.min(i + CHUNK_SIZE, urlsToProbe.length)} 个链接...`);
    const aliveChunk = await probeUrls(chunk);
    aliveChunk.forEach(u => validUrlsSet.add(u));
  }

  // ★ 优化3：生成最终的 M3U 内容
  const limitedEpgUrls = Array.from(globalEpgUrls).slice(0, 1);
  const epgUrlString = limitedEpgUrls.join(',');
  const epgHeader = epgUrlString ? ` x-tvg-url="${epgUrlString}"` : '';
  
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  let output = `#EXTM3U${epgHeader}\n# 自动更新时间: ${now}\n`;
  
  let totalChannels = 0;
  let totalLinks = 0;

  for (const [key, info] of templateChannels.entries()) {
    if (!channelUrlMap.has(key)) continue;
    
    const aliveUrlsForChannel = channelUrlMap.get(key).filter(url => validUrlsSet.has(url)).slice(0, 5);
    
    if (aliveUrlsForChannel.length > 0) {
        totalChannels++;
        for (const url of aliveUrlsForChannel) {
            let idStr = info.id ? ` tvg-id="${info.id}"` : '';
            let logoStr = info.logo ? ` tvg-logo="${info.logo}"` : '';
            output += `#EXTINF:-1${idStr} tvg-name="${info.name}" group-title="${info.group}"${logoStr},${info.name}\n`;
            output += `${url}\n`;
            totalLinks++;
        }
    }
  }

  fs.writeFileSync('hn.m3u', output);
  
  console.log(`\n🎉 处理完成！`);
  console.log(`🛡️  静态防线: 共拦截了 ${blockedCount} 条黑名单链接。`);
  console.log(`📡  动态测活: 共向国内节点发送 ${allCandidateUrls.length} 个链接探测，存活 ${validUrlsSet.size} 个。`);
  console.log(`📺  最终结果: 匹配到 ${totalChannels} 个模板频道，生成了 ${totalLinks} 条纯净播放链接。`);
}

main();
