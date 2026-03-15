const fs = require('fs');
const path = require('path'); 

// --- 1. 你要抓取的源列表配置 ---
const TASKS = [
  { url: "https://dsj-1312694395.cos.ap-guangzhou.myqcloud.com/dsj10.1.txt", ua: "AptvPlayer/1.2.5(iPhone)" }
];

// --- 2. 填写合并后的 EPG 链接 ---
const CUSTOM_EPG = "";

// --- 3. 读取外部的 template2.txt 文件 ---
const TEMPLATE = fs.readFileSync(path.join(__dirname, 'template2.txt'), 'utf-8');

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

// --- 5. 智能匹配源频道名到模板频道名 ---
function matchChannel(m3uChannelName) {
  let clean = m3uChannelName.toLowerCase().replace(/[-_ 　]/g, '');
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

// --- 6. 核心抓取与合并逻辑 (双核解析引擎) ---
async function main() {
  initTemplate();
  const globalEpgUrls = new Set(); 
  
  if (CUSTOM_EPG) {
    CUSTOM_EPG.split(',').forEach(url => globalEpgUrls.add(url.trim()));
  }

  for (const task of TASKS) {
    console.log(`正在抓取: ${task.url}`);
    try {
      const res = await fetch(task.url, { headers: { "User-Agent": task.ua } });
      if (!res.ok) {
        console.error(`抓取失败: 状态码 ${res.status}`);
        continue;
      }
      
      const text = await res.text();
      const lines = text.split('\n');
      
      let currentExtInf = '';
      let matchedKey = null;
      
      for (let line of lines) {
        line = line.trim();
        if (!line) continue;
        
        if (line.startsWith('#EXTM3U')) {
          let epgMatch = line.match(/x-tvg-url="([^"]+)"/i);
          if (epgMatch) {
            epgMatch[1].split(',').forEach(url => globalEpgUrls.add(url.trim()));
          }
          continue;
        }
        
        // ==========================================
        // 模式 1: 解析标准 M3U 格式
        // ==========================================
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
          templateChannels.get(matchedKey).urls.add(line);
          currentExtInf = '';
          matchedKey = null;
        }
        
        // ==========================================
        // 模式 2: 解析 TVBox / TXT 格式
        // ==========================================
        else if (line.includes(',') && !line.startsWith('#EXTINF')) {
          let parts = line.split(',');
          if (parts.length >= 2) {
            let txtName = parts[0].trim();
            let txtUrls = parts[1].trim();
            
            if (txtUrls === '#genre#') continue; // 跳过分类标签
            
            matchedKey = matchChannel(txtName);
            if (matchedKey) {
              let urlArray = txtUrls.split('#'); // 切割多个源
              for (let u of urlArray) {
                let pureUrl = u.split('$')[0].trim(); // 去除 $ 后面的备注
                if (pureUrl.startsWith('http') || pureUrl.startsWith('rtmp') || pureUrl.startsWith('rtsp')) {
                  templateChannels.get(matchedKey).urls.add(pureUrl);
                }
              }
              matchedKey = null; // 处理完一行 TXT 后重置，避免影响下一行
            }
          }
        }
      }
    } catch (e) {
      console.error(`请求报错: ${task.url}`, e.message);
    }
  }

  // --- 7. 生成最终的 M3U 内容 ---
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
    for (const url of info.urls) {
      let idStr = info.id ? ` tvg-id="${info.id}"` : '';
      let logoStr = info.logo ? ` tvg-logo="${info.logo}"` : '';
      
      output += `#EXTINF:-1${idStr} tvg-name="${info.name}" group-title="${info.group}"${logoStr},${info.name}\n`;
      output += `${url}\n`;
      totalLinks++;
    }
  }

  // 写入文件
  fs.writeFileSync('ss.m3u', output);
  console.log(`\n🎉 处理完成！`);
  console.log(`收集到了 ${globalEpgUrls.size} 个 EPG 节目单链接。`);
  console.log(`共匹配到 ${totalChannels} 个模板频道，生成了 ${totalLinks} 条播放链接。`);
}

main();
