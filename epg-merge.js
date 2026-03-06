const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// --- 1. EPG 源配置（按数组顺序匹配，排在前面的优先级更高） ---
const TASKS = [
  { url: "https://live.lizanyang.top/e.xml", ua: "Mozilla/5.0" },
  { url: "http://epg.51zmt.top:8000/e.xml.gz", ua: "Mozilla/5.0" },
  { url: "https://epg.cdn.loc.cc/xml", ua: "Mozilla/5.0" },
  { url: "http://exml.51zmt.top:11111/download2.php?f=e.xml.gz", ua: "Mozilla/5.0" },
  { url: "https://itv.sspai.indevs.in/erw.xml.gz", ua: "Mozilla/5.0" },
  { url: "http://47.119.24.76:59093/playback.xml", ua: "Mozilla/5.0" },
  { url: "https://epg.aptv.app/pp.xml.gz", ua: "AptvPlayer/1.2.5(iPhone)" },
  { url: "https://epg.aptv.app/xml", ua: "AptvPlayer/1.2.5(iPhone)" }
];

// --- 2. 读取并解析模板 ---
const TEMPLATE_PATH = path.join(__dirname, 'template.txt');
const templateChannels = new Map(); // key: 标准化名称, value: 模板原始名称

function initTemplate() {
  if (!fs.existsSync(TEMPLATE_PATH)) {
    console.error("找不到 template.txt 文件，请先创建！");
    process.exit(1);
  }
  const lines = fs.readFileSync(TEMPLATE_PATH, 'utf-8').split('\n');
  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    let key = line.toLowerCase().replace(/[-_ 　]/g, '');
    templateChannels.set(key, line);
  }
  console.log(`成功加载模板，共 ${templateChannels.size} 个目标频道。`);
}

// 智能匹配频道名
function matchChannel(epgName) {
  let clean = epgName.toLowerCase().replace(/[-_ 　]/g, '');
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

// --- 3. 抓取与解压逻辑 ---
async function fetchAndDecompress(task) {
  console.log(`正在请求 EPG: ${task.url}`);
  try {
    const res = await fetch(task.url, { headers: { "User-Agent": task.ua }, timeout: 15000 });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    
    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    
    // 判断是否为 GZIP 格式 (通过 Magic Number: 1F 8B)
    if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
      return zlib.gunzipSync(buffer).toString('utf-8');
    } else {
      return buffer.toString('utf-8');
    }
  } catch (err) {
    console.error(` ❌ 失败: ${err.message}`);
    return null;
  }
}

// --- 4. 核心合并与去重逻辑 ---
async function main() {
  initTemplate();

  const fulfilledChannels = new Set(); // 记录已经成功获取到节目的频道 (标准化名称)
  const outputChannels = []; // 存储最终的 <channel> XML 块
  const outputProgrammes = []; // 存储最终的 <programme> XML 块
  
  for (const task of TASKS) {
    // 如果所有模板频道都找到了节目，提前结束
    if (fulfilledChannels.size >= templateChannels.size) {
      console.log("🎉 所有模板频道均已找到节目单，跳过剩余 EPG 源。");
      break;
    }

    const xmlText = await fetchAndDecompress(task);
    if (!xmlText) continue;

    // 当前 EPG 源里，能映射到我们模板频道的 ID 字典
    // key: EPG原始ID, value: 我们的标准化名称
    const sourceIdMap = new Map(); 

    // 1. 提取所有 <channel> 块
    const channelRegex = /<channel\s+id="([^"]+)">([\s\S]*?)<\/channel>/g;
    for (const match of xmlText.matchAll(channelRegex)) {
      const originalId = match[1];
      const innerContent = match[2];
      const nameMatch = innerContent.match(/<display-name[^>]*>([^<]+)<\/display-name>/i);
      
      if (nameMatch) {
        const epgChannelName = nameMatch[1].trim();
        const matchedKey = matchChannel(epgChannelName);
        
        // 如果这个频道在我们的模板里，并且之前的高优先级源还没收录过它
        if (matchedKey && !fulfilledChannels.has(matchedKey)) {
          sourceIdMap.set(originalId, matchedKey);
        }
      }
    }

    if (sourceIdMap.size === 0) {
      console.log(` ⚠️ 该源没有提供我们需要的新频道，跳过。`);
      continue;
    }

    let programmesAdded = 0;

    // 2. 提取并替换 <programme> 块
    const progRegex = /<programme\s+([^>]+)>([\s\S]*?)<\/programme>/g;
    for (const match of xmlText.matchAll(progRegex)) {
      const attrs = match[1];
      const innerContent = match[2];
      
      const channelIdMatch = attrs.match(/channel="([^"]+)"/i);
      if (channelIdMatch) {
        const originalId = channelIdMatch[1];
        
        // 如果这个节目属于我们刚筛选出来的频道
        if (sourceIdMap.has(originalId)) {
          const matchedKey = sourceIdMap.get(originalId);
          const templateName = templateChannels.get(matchedKey);
          
          // ★ 重点：把 EPG 里乱七八糟的 ID，统一替换成我们模板里的标准名称
          const newAttrs = attrs.replace(`channel="${originalId}"`, `channel="${templateName}"`);
          outputProgrammes.push(`  <programme ${newAttrs}>\n${innerContent}\n  </programme>`);
          
          // 标记这个频道在这个源里已经提取到了节目
          fulfilledChannels.add(matchedKey);
          programmesAdded++;
        }
      }
    }

    console.log(` ✅ 从该源提取了 ${sourceIdMap.size} 个新频道的 ${programmesAdded} 条节目数据。`);
  }

  // --- 5. 生成对应的标准化 <channel> 头部 ---
  for (const matchedKey of fulfilledChannels) {
    const templateName = templateChannels.get(matchedKey);
    // 直接用标准名字作为 ID，完美契合 IPTV 列表
    outputChannels.push(`  <channel id="${templateName}">\n    <display-name lang="zh">${templateName}</display-name>\n  </channel>`);
  }

  // --- 6. 拼装并保存最终的 EPG XML ---
  const finalXml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE tv SYSTEM "xmltv.dtd">
<tv generator-info-name="GitHub Actions EPG Merge" generator-info-url="https://github.com">
${outputChannels.join('\n')}
${outputProgrammes.join('\n')}
</tv>`;

  fs.writeFileSync('epg.xml', finalXml);
  
  console.log(`\n🎉 EPG 聚合完成！共收录 ${fulfilledChannels.size}/${templateChannels.size} 个频道的节目单。`);
  console.log(`生成文件大小: ${(finalXml.length / 1024 / 1024).toFixed(2)} MB`);
}

main();
