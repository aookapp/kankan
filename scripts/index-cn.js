const fs = require('fs');
const path = require('path'); // 新增引入 path 模块
// --- 1. 你要抓取的源列表配置 ---
const TASKS = [
 { url: "https://itv.5iclub.dpdns.org/MiGu.m3u", ua: "AptvPlayer/1.2.5(iPhone)" },
 { url: "https://raw.githubusercontent.com/develop202/migu_video/refs/heads/main/interface.txt", ua: "Mozilla/5.0" },
 { url: "https://raw.githubusercontent.com/Kimentanm/aptv/master/m3u/iptv.m3u", ua: "Mozilla/5.0" },
 { url: "https://m.im5k.fun/mcp.m3u", ua: "AptvPlayer/1.2.5(iPhone)" },
 { url: "https://im5k.fun/iptv.m3u", ua: "AptvPlayer/1.2.5(iPhone)" },
 { url: "https://gitee.com/xxy002/zhiboyuan/raw/master/dsy", ua: "AptvPlayer/1.2.5(iPhone)" },
 { url: "https://raw.githubusercontent.com/YueChan/Live/main/IPTV.m3u", ua: "AptvPlayer/1.2.5(iPhone)" },
 { url: "https://raw.githubusercontent.com/ssili126/tv/refs/heads/main/itvlist.txt", ua: "Mozilla/5.0" },
 { url: "https://raw.githubusercontent.com/iptv-org/iptv/gh-pages/countries/cn.m3u", ua: "AptvPlayer/1.2.5(iPhone)" },
 { url: "https://raw.githubusercontent.com/iptv-org/iptv/master/streams/cn.m3u", ua: "AptvPlayer/1.2.5(iPhone)" }
];

// --- 2. 填写合并后的 EPG 链接 ---
const CUSTOM_EPG = "https://gh-proxy.com/https://raw.githubusercontent.com/aookapp/kankan/main/epg.xml";

// --- 3. 引入独立的配置 ---
const ALIAS_MAP = require('./alias.js');      // 引入频道别名配置
const BLOCK_LIST = require('./blocklist.js'); // ★ 新增：引入黑名单配置

// --- 4. 读取外部的 template.txt 文件 ---
const TEMPLATE = fs.readFileSync(path.join(__dirname, 'template.txt'), 'utf-8');

// --- 5. 解析模板并构建数据结构 ---
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

// --- 6. 智能匹配源频道名到模板频道名 ---
function matchChannel(m3uChannelName) {
  let clean = m3uChannelName.toLowerCase().replace(/[-_ 　]/g, '');
  
  for (const [standard, aliases] of Object.entries(ALIAS_MAP)) {
    if (clean.includes(standard)) {
      clean = standard;
      break;
    }
    if (aliases.some(alias => clean.includes(alias))) {
      clean = standard;
      break;
    }
  }

  if (templateChannels.has(clean)) return clean;
  
  let cleanNoSuffix = clean.replace(/hd|fhd|1080p|1080i|720p|超清|高清/g, '');
  if (templateChannels.has(cleanNoSuffix)) return cleanNoSuffix;
  
  for (const key of templateChannels.keys()) {
    if (clean.startsWith(key) || cleanNoSuffix.startsWith(key)) {
      if (key.match(/cctv\d+$/) && clean.match(new RegExp(`^${key}\\d`))) {
        continue;
      }
      return key;
    }
  }
  return null;
}

// ★ 新增：黑名单检测函数 ★
function isBlocked(url) {
  // 遍历黑名单，只要 URL 包含了黑名单里的任何一段字符串，就返回 true（该屏蔽）
  return BLOCK_LIST.some(keyword => url.includes(keyword));
}

// --- 7. 核心抓取与合并逻辑 ---
async function main() {
  initTemplate();
  const globalEpgUrls = new Set(); 
  let blockedCount = 0; // 统计拦截了多少个垃圾源
  
  if (CUSTOM_EPG) {
    CUSTOM_EPG.split(',').forEach(url => globalEpgUrls.add(url.trim()));
  }

  for (const task of TASKS) {
    console.log(`正在处理: ${task.url}`);
    try {
      let text = '';
      
      if (task.local) {
        const localPath = path.join(__dirname, '..', task.url);
        if (!fs.existsSync(localPath)) {
          console.error(`❌ 找不到本地文件: ${localPath}，请检查是否放在了根目录！`);
          continue;
        }
        text = fs.readFileSync(localPath, 'utf-8');
      } else {
        const res = await fetch(task.url, { headers: { "User-Agent": task.ua } });
        if (!res.ok) {
          console.error(`抓取失败: 状态码 ${res.status}`);
          continue; 
        }
        text = await res.text();
      }
      
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
          // ★ 新增：黑名单拦截
          if (isBlocked(line)) {
            blockedCount++;
          } else {
            templateChannels.get(matchedKey).urls.add(line);
          }
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
              let urlArray = txtUrls.split('#'); 
              for (let u of urlArray) {
                let pureUrl = u.split('$')[0].trim(); 
                if (pureUrl.startsWith('http') || pureUrl.startsWith('rtmp') || pureUrl.startsWith('rtsp')) {
                  // ★ 新增：黑名单拦截
                  if (isBlocked(pureUrl)) {
                    blockedCount++;
                  } else {
                    templateChannels.get(matchedKey).urls.add(pureUrl);
                  }
                }
              }
              matchedKey = null; 
            }
          }
        }
      }
    } catch (e) {
      console.error(`请求报错: ${task.url}`, e.message);
    }
  }

  // --- 8. 生成最终的 M3U 内容 ---
  const limitedEpgUrls = Array.from(globalEpgUrls).slice(0, 1);
  const epgUrlString = limitedEpgUrls.join(',');
  const epgHeader = epgUrlString ? ` x-tvg-url="${epgUrlString}"` : '';
  
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  let output = `#EXTM3U${epgHeader}\n# 自动更新时间: ${now}\n`;
  
  let totalChannels = 0;
  let totalLinks = 0;

  for (const [key, info] of templateChannels.entries()) {
    if (info.urls.size === 0) continue;
    
    totalChannels++;
    
    const limitedUrls = Array.from(info.urls).slice(0, 5);
    
    for (const url of limitedUrls) {
      let idStr = info.id ? ` tvg-id="${info.id}"` : '';
      let logoStr = info.logo ? ` tvg-logo="${info.logo}"` : '';
      
      output += `#EXTINF:-1${idStr} tvg-name="${info.name}" group-title="${info.group}"${logoStr},${info.name}\n`;
      output += `${url}\n`;
      totalLinks++;
    }
  }

  // 写入文件
  fs.writeFileSync('cn.m3u', output);
  
  console.log(`\n🎉 处理完成！`);
  console.log(`🛡️  防线生效: 共拦截了 ${blockedCount} 条黑名单失效链接。`);
  console.log(`收集到了 ${globalEpgUrls.size} 个 EPG 节目单链接。`);
  console.log(`共匹配到 ${totalChannels} 个模板频道，生成了 ${totalLinks} 条纯净播放链接 (每个频道最多保留 5 个)。`);
}

main();

main();
