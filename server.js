import express from 'express';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import axios from 'axios';
import * as cheerio from 'cheerio';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function scrapeAmazon(url) {
  const { data } = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    },
    timeout: 15000,
  });

  const $ = cheerio.load(data);

  const title = $('#productTitle').text().trim() || $('h1[id="title"]').text().trim() || '';

  const priceText =
    $('.a-price .a-offscreen').first().text().trim() ||
    $('#priceblock_ourprice').text().trim() ||
    $('#priceblock_dealprice').text().trim() ||
    '';
  const price = priceText ? parseFloat(priceText.replace(/[^0-9.]/g, '')) : null;

  let img = '';
  const imgDataMatch = data.match(/"hiRes":"(https:\/\/[^"]+)"/);
  if (imgDataMatch) {
    img = imgDataMatch[1];
  } else {
    img = $('#landingImage').attr('src') || $('.a-dynamic-image').first().attr('src') || '';
  }

  return { title, price, img };
}

// Amazon 스크래핑으로 제목/가격/이미지 자동완성
app.post('/api/scrape', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL이 필요합니다.' });

  try {
    const result = await scrapeAmazon(url);
    if (!result.title && !result.price && !result.img) {
      return res.status(422).json({ error: 'Amazon 페이지에서 정보를 가져오지 못했습니다. 다른 링크를 시도해보세요.' });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: `스크래핑 실패: ${err.message}` });
  }
});

// 이미지를 Supabase Storage에 업로드
app.post('/api/upload-image', async (req, res) => {
  const { imageUrl } = req.body;
  if (!imageUrl) return res.status(400).json({ error: 'imageUrl이 필요합니다.' });

  try {
    const axiosRes = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 15000 });
    const contentType = axiosRes.headers['content-type'] || 'image/jpeg';
    const ext = contentType.includes('png') ? '.png' : contentType.includes('webp') ? '.webp' : '.jpg';
    const filename = `deal_${Date.now()}${ext}`;

    const { error } = await supabase.storage
      .from('images')
      .upload(filename, Buffer.from(axiosRes.data), { contentType, upsert: true });

    if (error) throw new Error(error.message);
    const { data } = supabase.storage.from('images').getPublicUrl(filename);
    res.json({ url: data.publicUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Supabase에 딜 저장
app.post('/api/save', async (req, res) => {
  const { title, cat, price, original, link, img } = req.body;
  if (!title) return res.status(400).json({ error: '상품명이 필요합니다.' });

  try {
    const { data, error } = await supabase
      .from('deals')
      .insert({ title, cat, store: 'Amazon', price, original, link, img })
      .select('id');

    if (error) throw new Error(error.message);
    res.json({ id: data[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`KoDeal 어드민: http://localhost:${PORT}`));
