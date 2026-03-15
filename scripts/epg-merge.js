const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ==========================================
// ⚙️ EPG 超级控制面板
// ==========================================

const AUTHOR_NAME = "aook";          // 1. 修改作者名
const INCLUDE_YESTERDAY = false;     // 2. 是否保留昨天的数据？(true 保留，false 排除以极速加载)

// 3. 广告屏蔽词典 (支持正则，发现新的广告随时往这里面加)
const AD_KEYWORDS = [
  /由[a-zA-Z0-9\.\/:-_]+提供节目单服务/gi,  // 拦截如 "由https://epg...提供"
  /欢迎使用.*?/gi,
  /关注微信公众号.*?/gi,
  /更多节目请访问.*?/gi
];

// 4. 引入简繁转换库 (自动将繁体转为简体)
let converter = (text) => text; // 默认原样输出
try {
  const OpenCC = require('opencc-js');
  converter = OpenCC.Converter({ from: 't', to: 'cn' });
} catch (e) {
  console.log("⚠️ 未检测到 opencc-js 库，跳过简繁转换。请确保在 workflow 中运行了 npm install opencc-js");
}

// ==========================================

// --- 1. EPG 源配置 ---
const TASKS = [
  { url: "https://epg.aptv.app/xml", ua: "AptvPlayer/1.2.5(iPhone)" },
  { url: "http://exml.51zmt.top:11111/download2.php?f=e.xml.gz", ua: "Mozilla/5.0" },
  { url: "http://epg.51zmt.top:8000/e1.xml.gz", ua: "Mozilla/5.0" },
  { url: "https://epg.cdn.loc.cc/xml", ua: "Mozilla/5.0" },
  { url: "https://itv.sspai.indevs.in/erw.xml.gz", ua: "Mozilla/5.0" },
  { url: "http://47.119.24.76:59093/playback.xml", ua: "Mozilla/5.0" },
  { url: "https://epg.aptv.app/pp.xml.gz", ua: "AptvPlayer/1.2.5(iPhone)" }

];

// --- 2. 读取并解析模板 ---
const TEMPLATE_PATH = path.join(__dirname, 'template.txt');
const templateChannels = new Map();

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

// --- 3. 动态生成有效日期范围 (加入控制开关) ---
function getValidDates() {
  const dates = new Set();
  const now = new Date();
  const beijingTime = new Date(now.getTime() + (now.getTimezoneOffset() * 60000) + (8 * 3600000));
  
  // 根据顶部开关决定是从昨天(-1)开始，还是从今天(0)开始
  const startOffset = INCLUDE_YESTERDAY ? -1 : 0; 

  // 保留到后天(2)
  for (let i = startOffset; i <= 1; i++) {
    const d = new Date(beijingTime.getTime() + i * 86400000);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    dates.add(`${yyyy}${mm}${dd}`);
  }
  return dates;
}

const VALID_DATES = getValidDates();

// --- 4. 抓取与解压逻辑 ---
async function fetchAndDecompress(task) {
  console.log(`正在请求 EPG: ${task.url}`);
  try {
    const res = await fetch(task.url, { headers: { "User-Agent": task.ua }, timeout: 15000 });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    
    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    
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

// --- 清洗节目内容函数 (去广告 + 繁转简) ---
function cleanContent(content) {
  let cleaned = content;
  // 1. 繁体转简体
  cleaned = converter(cleaned);
  // 2. 移除广告
  for (const regex of AD_KEYWORDS) {
    cleaned = cleaned.replace(regex, '');
  }
  return cleaned;
}

// --- 5. 核心合并与按天互补逻辑 ---
async function main() {
  initTemplate();
  console.log(`当前允许保留的节目日期:`, Array.from(VALID_DATES));

  const fulfilledChannels = new Set(); 
  const fulfilledChannelDates = new Set(); 
  const outputChannels = []; 
  const outputProgrammes = []; 
  
  const targetFulfillmentCount = templateChannels.size * VALID_DATES.size;

  for (const task of TASKS) {
    if (fulfilledChannelDates.size >= targetFulfillmentCount) break;

    const xmlText = await fetchAndDecompress(task);
    if (!xmlText) continue;

    const sourceIdMap = new Map(); 

    const channelRegex = /<channel\s+id="([^"]+)">([\s\S]*?)<\/channel>/g;
    for (const match of xmlText.matchAll(channelRegex)) {
      const originalId = match[1];
      const nameMatch = match[2].match(/<display-name[^>]*>([^<]+)<\/display-name>/i);
      
      if (nameMatch) {
        const epgChannelName = nameMatch[1].trim();
        const matchedKey = matchChannel(epgChannelName);
        if (matchedKey) sourceIdMap.set(originalId, matchedKey);
      }
    }

    if (sourceIdMap.size === 0) continue;

    let programmesAdded = 0;
    let programmesIgnored = 0; 
    const datesAddedThisSource = new Set(); 

    const progRegex = /<programme\s+([^>]+)>([\s\S]*?)<\/programme>/g;
    for (const match of xmlText.matchAll(progRegex)) {
      const attrs = match[1];
      let innerContent = match[2];
      
      const startMatch = attrs.match(/start="(\d{8})/);
      if (!startMatch) continue;
      const progDate = startMatch[1]; 

      if (!VALID_DATES.has(progDate)) {
        programmesIgnored++;
        continue; 
      }

      const channelIdMatch = attrs.match(/channel="([^"]+)"/i);
      if (!channelIdMatch) continue;
      const originalId = channelIdMatch[1];
        
      if (sourceIdMap.has(originalId)) {
        const matchedKey = sourceIdMap.get(originalId);
        const fulfillmentKey = `${matchedKey}_${progDate}`; 
        
        if (fulfilledChannelDates.has(fulfillmentKey)) continue;

        datesAddedThisSource.add(fulfillmentKey);
        const templateName = templateChannels.get(matchedKey);
        
        const newAttrs = attrs.replace(`channel="${originalId}"`, `channel="${templateName}"`);
        
        // ★ 对节目内容进行过滤：繁转简 + 剔除广告
        innerContent = cleanContent(innerContent);
        
        outputProgrammes.push(`  <programme ${newAttrs}>\n${innerContent}\n  </programme>`);
        
        fulfilledChannels.add(matchedKey);
        programmesAdded++;
      }
    }

    datesAddedThisSource.forEach(key => fulfilledChannelDates.add(key));

    console.log(` ✅ 提取 ${datesAddedThisSource.size} 组有效频道的单日数据，共 ${programmesAdded} 条节目 (过滤掉 ${programmesIgnored} 条)。`);
  }

  for (const matchedKey of fulfilledChannels) {
    const templateName = templateChannels.get(matchedKey);
    outputChannels.push(`  <channel id="${templateName}">\n    <display-name lang="zh">${templateName}</display-name>\n  </channel>`);
  }

  // ★ 作者名已替换为你专属的 aook
  const finalXml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE tv SYSTEM "xmltv.dtd">
<tv generator-info-name="${AUTHOR_NAME}" generator-info-url="https://github.com">
${outputChannels.join('\n')}
${outputProgrammes.join('\n')}
</tv>`;

  fs.writeFileSync('epg.xml', finalXml);
  
  console.log(`\n🎉 EPG 聚合完成！共收录 ${fulfilledChannels.size}/${templateChannels.size} 个频道。`);
  console.log(`生成文件大小: ${(finalXml.length / 1024 / 1024).toFixed(2)} MB`);
}

main();
