const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// --- 1. EPG 源配置 ---
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

// --- 3. 动态生成有效日期范围 ---
function getValidDates() {
  const dates = new Set();
  const now = new Date();
  const beijingTime = new Date(now.getTime() + (now.getTimezoneOffset() * 60000) + (8 * 3600000));
  
  // 保留昨天、今天、明天、后天
  for (let i = -1; i <= 2; i++) {
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

// --- 5. 核心合并与按天互补逻辑 ---
async function main() {
  initTemplate();
  console.log(`当前允许保留的节目日期:`, Array.from(VALID_DATES));

  const fulfilledChannels = new Set(); // 记录最终收录了哪些频道（用于生成 XML 头）
  const fulfilledChannelDates = new Set(); // ★ 核心：记录“频道_日期”，如 "cctv1_20260306"
  const outputChannels = []; 
  const outputProgrammes = []; 
  
  // 计算最完美的完成状态：所有频道 * 所有有效日期 都收集齐了
  const targetFulfillmentCount = templateChannels.size * VALID_DATES.size;

  for (const task of TASKS) {
    // 如果所有的频道、所有的日期都拼齐了，直接提前结束！
    if (fulfilledChannelDates.size >= targetFulfillmentCount) {
      console.log("🎉 所有频道的所需日期均已完美补齐，跳过剩余源！");
      break;
    }

    const xmlText = await fetchAndDecompress(task);
    if (!xmlText) continue;

    const sourceIdMap = new Map(); 

    // 先扫一遍当前源，把能匹配上的频道 ID 提取出来
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
    const datesAddedThisSource = new Set(); // 记录当前源贡献了哪些“频道_日期”

    const progRegex = /<programme\s+([^>]+)>([\s\S]*?)<\/programme>/g;
    for (const match of xmlText.matchAll(progRegex)) {
      const attrs = match[1];
      const innerContent = match[2];
      
      const startMatch = attrs.match(/start="(\d{8})/);
      if (!startMatch) continue;
      const progDate = startMatch[1]; 

      // 1. 如果日期不在白名单，丢弃
      if (!VALID_DATES.has(progDate)) {
        programmesIgnored++;
        continue; 
      }

      const channelIdMatch = attrs.match(/channel="([^"]+)"/i);
      if (!channelIdMatch) continue;
      const originalId = channelIdMatch[1];
        
      if (sourceIdMap.has(originalId)) {
        const matchedKey = sourceIdMap.get(originalId);
        const fulfillmentKey = `${matchedKey}_${progDate}`; // 例如 "cctv1_20260306"
        
        // 2. ★ 如果排在前面的高级源，已经提供了这个频道这一天的节目单，我们就跳过它，防止时间线重叠错乱
        if (fulfilledChannelDates.has(fulfillmentKey)) continue;

        // 3. 这是一个我们需要的新数据！收下它！
        datesAddedThisSource.add(fulfillmentKey);
        const templateName = templateChannels.get(matchedKey);
        
        const newAttrs = attrs.replace(`channel="${originalId}"`, `channel="${templateName}"`);
        outputProgrammes.push(`  <programme ${newAttrs}>\n${innerContent}\n  </programme>`);
        
        fulfilledChannels.add(matchedKey);
        programmesAdded++;
      }
    }

    // 当前源全部处理完后，把它贡献的日期锁定到全局记录里
    datesAddedThisSource.forEach(key => fulfilledChannelDates.add(key));

    console.log(` ✅ 提取 ${datesAddedThisSource.size} 组有效频道的单日数据，共 ${programmesAdded} 条节目 (过滤掉 ${programmesIgnored} 条)。`);
    console.log(` 📊 当前总体收集进度: ${fulfilledChannelDates.size} / ${targetFulfillmentCount}`);
  }

  // --- 6. 生成 XML 头部与尾部 ---
  for (const matchedKey of fulfilledChannels) {
    const templateName = templateChannels.get(matchedKey);
    outputChannels.push(`  <channel id="${templateName}">\n    <display-name lang="zh">${templateName}</display-name>\n  </channel>`);
  }

  const finalXml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE tv SYSTEM "xmltv.dtd">
<tv generator-info-name="GitHub Actions EPG Merge" generator-info-url="https://github.com">
${outputChannels.join('\n')}
${outputProgrammes.join('\n')}
</tv>`;

  fs.writeFileSync('epg.xml', finalXml);
  
  console.log(`\n🎉 EPG 聚合完成！共收录 ${fulfilledChannels.size}/${templateChannels.size} 个频道。`);
  console.log(`生成文件大小: ${(finalXml.length / 1024 / 1024).toFixed(2)} MB`);
}

main();
