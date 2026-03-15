const fs = require('fs');
const path = require('path'); 

// --- 1. 你要抓取的源列表配置 ---
const TASKS = [
  { url: "https://dsj-1312694395.cos.ap-guangzhou.myqcloud.com/dsj10.1.txt", ua: "Mozilla/5.0" }
];

// --- 2. 填写合并后的 EPG 链接 ---
const CUSTOM_EPG = "https://kan.935999.xyz/epg.xml";

// --- 3. 读取外部的 template.txt 文件 ---
const TEMPLATE = fs.readFileSync(path.join(__dirname, 'template.txt'), 'utf-8');

// --- 4. 解析模板并构建数据结构 ---
const templateChannels = new Map(); 

function initTemplate() {
  let currentGroup = '未分类';
  const lines = TEMPLATE.split('\n');
  
  for (let line of lines) {
    line = line.trim();
    if (!line) continue;
    
    if (line.startsWith('#')) {
      currentGroup = line.substring(1).trim(); 
    } else {
      let key = line.toLowerCase().replace(/[-_ 　]/g, '');
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

function matchChannel(m3uChannelName) {
  let clean = m3uChannelName.toLowerCase().replace(/[-_ 　]/g, '');
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

// --- ⚡ 新增：单条链接测速与有效性检测函数 ---
async function checkUrlAlive(url) {
  if (!url.startsWith('http')) return false; 
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000); // 增加到 5 秒

    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    // 如果返回 404，那一定是挂了，删掉
    if (res.status === 404) return false;

    // 如果是超时或者其他错误，在国外测不准的情况下，我们选择“宁可信其有”
    return true; 
  } catch (err) {
    // 捕获到超时错误（AbortError），返回 true 给予留任机会
    if (err.name === 'AbortError') return true; 
    return false;
  }
}

// --- ⚡ 新增：批量并发检测 (防止成百上千个请求同时发出去卡死) ---
async function filterAliveUrls(urlsSet) {
  const urlsArray = Array.from(urlsSet);
  const aliveUrls = [];
  const batchSize = 30; // 每次并发测试 30 个链接

  for (let i = 0; i < urlsArray.length; i += batchSize) {
    const batch = urlsArray.slice(i, i + batchSize);
    // 并发检测这 30 个链接
    const results = await Promise.all(batch.map(async (url) => {
      const isAlive = await checkUrlAlive(url);
      return { url, isAlive };
    }));
    
    // 把存活的挑选出来
    results.forEach(item => {
      if (item.isAlive) aliveUrls.push(item.url);
    });
  }
  return aliveUrls;
}

// --- 5. 核心抓取与合并逻辑 ---
async function main() {
  initTemplate();
  const globalEpgUrls = new Set();
  if (CUSTOM_EPG) CUSTOM_EPG.split(',').forEach(url => globalEpgUrls.add(url.trim()));

  for (const task of TASKS) {
    console.log(`正在抓取: ${task.url}`);
    try {
      const res = await fetch(task.url, { headers: { "User-Agent": task.ua } });
      if (!res.ok) continue;
      
      const text = await res.text();
      const lines = text.split('\n');
      let currentExtInf = '';
      let matchedKey = null;
      
      for (let line of lines) {
        line = line.trim();
        if (line.startsWith('#EXTM3U')) continue;
        
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
        } else if (line.startsWith('http')) { // 修复：只保留 http 开头的链接
          if (matchedKey && currentExtInf) {
            templateChannels.get(matchedKey).urls.add(line);
          }
          currentExtInf = '';
          matchedKey = null;
        }
      }
    } catch (e) {
      console.error(`请求报错: ${task.url}`, e.message);
    }
  }

  // --- ⚡ 新阶段：全量测速过滤死链 ---
  console.log(`\n============================`);
  console.log(`🚀 开始对抓取到的链接进行测速过滤 (超时时间: 2.5秒)...`);
  console.log(`============================\n`);
  
  let totalOriginalLinks = 0;
  let totalAliveLinks = 0;

  for (const [key, info] of templateChannels.entries()) {
    if (info.urls.size === 0) continue;
    
    const originalSize = info.urls.size;
    totalOriginalLinks += originalSize;
    
    // 执行过滤函数，用存活的链接覆盖原来的 Set
    const aliveList = await filterAliveUrls(info.urls);
    info.urls = new Set(aliveList);
    
    totalAliveLinks += aliveList.length;
    
    // 打印过滤前后的对比，让你直观看到杀掉了多少死链
    if (originalSize !== aliveList.length) {
       console.log(`[${info.name}] 净化完成: ${originalSize} 个源 -> 剔除 ${originalSize - aliveList.length} 个失效源`);
    }
  }

  // --- 6. 生成最终的 M3U 内容 ---
  const limitedEpgUrls = Array.from(globalEpgUrls).slice(0, 1);
  const epgUrlString = limitedEpgUrls.join(',');
  const epgHeader = epgUrlString ? ` x-tvg-url="${epgUrlString}"` : '';
  
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  let output = `#EXTM3U${epgHeader}\n# 自动更新时间: ${now}\n`;
  
  let totalChannels = 0;

  for (const [key, info] of templateChannels.entries()) {
    if (info.urls.size === 0) continue; 
    
    totalChannels++;
    for (const url of info.urls) {
      let idStr = info.id ? ` tvg-id="${info.id}"` : '';
      let logoStr = info.logo ? ` tvg-logo="${info.logo}"` : '';
      output += `#EXTINF:-1${idStr} tvg-name="${info.name}" group-title="${info.group}"${logoStr},${info.name}\n`;
      output += `${url}\n`;
    }
  }

  // 写入专属的过滤版文件
  fs.writeFileSync('kankan-gl.m3u', output);
  fs.writeFileSync('gl.m3u', output);
  
  console.log(`\n🎉 过滤处理完成！`);
  console.log(`🛡️ 测速战果: 共检查了 ${totalOriginalLinks} 条链接，剔除了 ${totalOriginalLinks - totalAliveLinks} 条死链！`);
  console.log(`最终生成包含 ${totalChannels} 个频道，共 ${totalAliveLinks} 条纯净极速播放链接。`);
}

main();
