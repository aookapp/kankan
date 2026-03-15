const fs = require('fs');
const path = require('path'); 

// --- 1. 你要抓取的源列表配置 ---
const TASKS = [
  { url: "https://dsj-1312694395.cos.ap-guangzhou.myqcloud.com/dsj10.1.txt", ua: "AptvPlayer/1.2.5(iPhone)" }
  
//   { url: "https://itv.aptv.app/china-iptv/zgyd.m3u", ua: "AptvPlayer/1.2.5(iPhone)" }
//   { url: "https://raw.githubusercontent.com/Kimentanm/aptv/master/m3u/iptv.m3u", ua: "Mozilla/5.0" }
];

// --- 2. 填写合并后的 EPG 链接 ---
const CUSTOM_EPG = "";

// --- 3. 读取外部的 template.txt 文件 ---
const TEMPLATE = fs.readFileSync(path.join(__dirname, 'template2.txt'), 'utf-8');

// --- 4. 解析模板并构建数据结构（整份文件这里只能出现一次！） ---
const templateChannels = new Map(); 

function initTemplate() {
  let currentGroup = '未分类';
  const lines = TEMPLATE.split('\n');
// ... 后面原封不动保留
  
  let currentExtInf = '';
      let matchedKey = null;
      
      for (let line of lines) {
        line = line.trim();
        if (!line) continue;
        if (line.startsWith('#EXTM3U')) continue;
        
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
        else if (line.startsWith('http') && matchedKey && currentExtInf) {
          templateChannels.get(matchedKey).urls.add(line);
          currentExtInf = '';
          matchedKey = null;
        }
        
        // ==========================================
        // 模式 2: 解析 TVBox / TXT 格式 (新增)
        // ==========================================
        else if (line.includes(',')) {
          // 很多 TXT 源会用逗号分隔频道名和链接
          let parts = line.split(',');
          if (parts.length >= 2) {
            let txtName = parts[0].trim();
            let txtUrls = parts[1].trim();
            
            // 跳过 TXT 格式里的分类标签行 (例如: 央视频道,#genre#)
            if (txtUrls === '#genre#') continue;
            
            matchedKey = matchChannel(txtName);
            if (matchedKey) {
              // TXT 源可能在一行里用 # 塞了多个链接
              let urlArray = txtUrls.split('#');
              for (let u of urlArray) {
                // 剔除链接后面带的类似 $山西联通 的备注信息
                let pureUrl = u.split('$')[0].trim();
                // 确保提取出来的是有效的网络链接
                if (pureUrl.startsWith('http')) {
                  templateChannels.get(matchedKey).urls.add(pureUrl);
                }
              }
            }
          }
        }
      }

// --- 4. 智能匹配源频道名到模板频道名 ---
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

// --- 5. 核心抓取与合并逻辑 ---
async function main() {
  initTemplate();
  const globalEpgUrls = new Set(); // 存储所有抓取到的 EPG 链接
  
  // 加入自定义 EPG
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
        
        // 提取原文件的全局 EPG 链接
        if (line.startsWith('#EXTM3U')) {
          let epgMatch = line.match(/x-tvg-url="([^"]+)"/i);
          if (epgMatch) {
            epgMatch[1].split(',').forEach(url => globalEpgUrls.add(url.trim()));
          }
          continue;
        }
        
        if (line.startsWith('#EXTINF')) {
          currentExtInf = line;
          let m3uName = line.substring(line.lastIndexOf(',') + 1).trim();
          matchedKey = matchChannel(m3uName);
          
          if (matchedKey) {
            let channelObj = templateChannels.get(matchedKey);
            
            // 提取台标 (如果还没提取到的话)
            let logoMatch = currentExtInf.match(/tvg-logo="([^"]+)"/i);
            if (logoMatch && !channelObj.logo) {
              channelObj.logo = logoMatch[1];
            }
            
            // 提取 EPG 对应的 tvg-id (如果还没提取到的话)
            let idMatch = currentExtInf.match(/tvg-id="([^"]+)"/i);
            if (idMatch && !channelObj.id) {
              channelObj.id = idMatch[1];
            }
          }
        } else if (line.startsWith('http') || line.startsWith('rtmp') || line.startsWith('rtsp')) {
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

  // --- 6. 生成最终的 M3U 内容 ---
  // --- 6. 生成最终的 M3U 内容 ---
  // 将收集到的 EPG 链接转为数组，并限制最多只保留前 3 个
  const limitedEpgUrls = Array.from(globalEpgUrls).slice(0, 1);
  const epgUrlString = limitedEpgUrls.join(',');
  const epgHeader = epgUrlString ? ` x-tvg-url="${epgUrlString}"` : '';
  
  // 头部加入 EPG 链接和更新时间
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  let output = `#EXTM3U${epgHeader}\n# 自动更新时间: ${now}\n`;
  
  let totalChannels = 0;
  let totalLinks = 0;

  for (const [key, info] of templateChannels.entries()) {
    if (info.urls.size === 0) continue;
    
    totalChannels++;
    for (const url of info.urls) {
      // 组装带 id 和 logo 的扩展属性标签
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
