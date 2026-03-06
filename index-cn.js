const fs = require('fs');
const path = require('path'); // 新增引入 path 模块
// --- 1. 你要抓取的源列表配置 ---
const TASKS = [
 { url: "https://itv.5iclub.dpdns.org/MiGu.m3u", ua: "AptvPlayer/1.2.5(iPhone)" },
 { url: "https://raw.githubusercontent.com/Kimentanm/aptv/master/m3u/iptv.m3u", ua: "Mozilla/5.0" },
 { url: "https://m.im5k.fun/mcp.m3u", ua: "AptvPlayer/1.2.5(iPhone)" },
 { url: "https://im5k.fun/iptv.m3u", ua: "AptvPlayer/1.2.5(iPhone)" },
 { url: "https://gitee.com/xxy002/zhiboyuan/raw/master/dsy", ua: "AptvPlayer/1.2.5(iPhone)" },
 { url: "https://raw.githubusercontent.com/YueChan/Live/main/IPTV.m3u", ua: "AptvPlayer/1.2.5(iPhone)" },
 { url: "https://raw.githubusercontent.com/ssili126/tv/refs/heads/main/itvlist.txt", ua: "Mozilla/5.0" },
 { url: "https://raw.githubusercontent.com/iptv-org/iptv/gh-pages/countries/cn.m3u", ua: "AptvPlayer/1.2.5(iPhone)" },
 { url: "https://raw.githubusercontent.com/iptv-org/iptv/master/streams/cn.m3u", ua: "AptvPlayer/1.2.5(iPhone)" }
];

// 如果你需要强行指定一个稳定的 EPG 节目单源，可以在这里填入，多个用逗号隔开
// 留空则完全依赖自动从上述源文件中提取
// --- 2. 填写合并后的 EPG 链接 ---
const CUSTOM_EPG = "https://hk.gh-proxy.org/https://github.com/aookapp/kankan/blob/main/epg.xml,https://raw.githubusercontent.com/aookapp/kankan/main/epg.xml";

//

// --- 3. 读取同目录下的 template.txt 文件 ---
const TEMPLATE = fs.readFileSync(path.join(__dirname, 'template.txt'), 'utf-8');

// --- 4. 解析模板并构建数据结构 ---
const templateChannels = new Map(); // 使用 Map 保持模板的插入顺序

function initTemplate() {
  let currentGroup = '未分类';
  const lines = TEMPLATE.split('\n');
  
  for (let line of lines) {
    line = line.trim();
    if (!line) continue;
    
    if (line.startsWith('#')) {
      currentGroup = line.substring(1).trim(); // 获取分组名
    } else {
      // 将频道名标准化（去空格、短横线，转小写），作为匹配用的唯一键值
      let key = line.toLowerCase().replace(/[-_ 　]/g, '');
      templateChannels.set(key, { 
        name: line,         // 你模板里原本的名字
        group: currentGroup,// 所属分类
        id: '',             // 预留 EPG 频道 ID 位置
        logo: '',           // 预留台标位置
        urls: new Set()     // 使用 Set 存储该频道对应的所有去重播放链接
      });
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
  // 直接强制使用你在代码最顶部填写的 CUSTOM_EPG，无视别人源里的垃圾 EPG
  const epgHeader = CUSTOM_EPG ? ` x-tvg-url="${CUSTOM_EPG}"` : '';
  
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
  fs.writeFileSync('kankan-cn.m3u', output);
  console.log(`\n🎉 处理完成！`);
  console.log(`收集到了 ${globalEpgUrls.size} 个 EPG 节目单链接。`);
  console.log(`共匹配到 ${totalChannels} 个模板频道，生成了 ${totalLinks} 条播放链接。`);
}

main();
