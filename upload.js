#!/usr/bin/env node
// KoDeal — Amazon 딜 업로드 스크립트
// 사용법: node upload.js [amazon-url]

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { createInterface } from 'readline';
import fs from 'fs';
import path from 'path';

// readline/promises는 piped stdin에서 EOF시 인터페이스를 닫아 이후 question()이 reject됨.
// 직접 라인 버퍼링으로 처리.
function createRL() {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: !!process.stdout.isTTY,
  });
  const queue = [];
  const waiters = [];
  rl.on('line', (line) => {
    if (waiters.length > 0) waiters.shift()(line);
    else queue.push(line);
  });
  return {
    question: (prompt) => {
      process.stdout.write(prompt);
      if (queue.length > 0) return Promise.resolve(queue.shift());
      return new Promise((res) => waiters.push(res));
    },
    close: () => rl.close(),
  };
}

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const AFFILIATE_TAG = 'kodeal-20';
const CATEGORIES = ['전자제품', '뷰티', '주방', '패션', '스포츠', '홈/가구', '식품', '도서', '완구', '기타'];

function addAffiliateTag(url) {
  try {
    const u = new URL(url);
    u.searchParams.set('tag', AFFILIATE_TAG);
    // 불필요한 파라미터 정리
    for (const key of [...u.searchParams.keys()]) {
      if (!['tag', 'dp', 'th', 'psc'].includes(key) && !u.pathname.includes(key)) {
        // keep 'tag' only
      }
    }
    return u.toString();
  } catch {
    return url;
  }
}

async function scrapeAmazon(url) {
  try {
    const { data } = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'max-age=0',
      },
      timeout: 15000,
    });

    const $ = cheerio.load(data);

    const title =
      $('#productTitle').text().trim() ||
      $('h1[id="title"]').text().trim() ||
      '';

    const priceText =
      $('.a-price .a-offscreen').first().text().trim() ||
      $('#priceblock_ourprice').text().trim() ||
      $('#priceblock_dealprice').text().trim() ||
      '';
    const price = priceText ? parseFloat(priceText.replace(/[^0-9.]/g, '')) : null;

    // 고해상도 이미지 URL 추출 (JSON 데이터에서)
    let img = '';
    const imgDataMatch = data.match(/"hiRes":"(https:\/\/[^"]+)"/);
    if (imgDataMatch) {
      img = imgDataMatch[1];
    } else {
      img =
        $('#landingImage').attr('src') ||
        $('#imgBlkFront').attr('src') ||
        $('.a-dynamic-image').first().attr('src') ||
        '';
    }

    return { title, price, img };
  } catch (e) {
    return { title: '', price: null, img: '', error: e.message };
  }
}

async function uploadToStorage(bufferOrPath, filename, contentType = 'image/jpeg') {
  let buffer;
  if (typeof bufferOrPath === 'string') {
    buffer = fs.readFileSync(bufferOrPath);
    const ext = path.extname(bufferOrPath).toLowerCase();
    contentType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    filename = filename + ext;
  } else {
    buffer = bufferOrPath;
  }

  const { error } = await supabase.storage
    .from('images')
    .upload(filename, buffer, { contentType, upsert: true });

  if (error) throw new Error(`Storage 업로드 실패: ${error.message}`);

  const { data } = supabase.storage.from('images').getPublicUrl(filename);
  return data.publicUrl;
}

async function downloadImage(url, filename) {
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000 });
  const contentType = res.headers['content-type'] || 'image/jpeg';
  const ext = contentType.includes('png') ? '.png' : contentType.includes('webp') ? '.webp' : '.jpg';
  return uploadToStorage(Buffer.from(res.data), filename + ext, contentType);
}

async function prompt(rl, question, fallback = '') {
  const hint = fallback ? ` [${fallback}]` : '';
  const answer = (await rl.question(`${question}${hint}: `)).trim();
  return answer || fallback;
}

async function main() {
  const rl = createRL();

  try {
    console.log('\nKoDeal 딜 업로드\n');

    // 1. Amazon URL
    let amazonUrl = (process.argv[2] || '').trim();
    if (!amazonUrl) {
      amazonUrl = (await rl.question('Amazon URL: ')).trim();
    }
    const dealLink = addAffiliateTag(amazonUrl);

    // 2. 스크래핑 시도
    process.stdout.write('아마존 정보 수집 중...');
    const scraped = await scrapeAmazon(amazonUrl);
    process.stdout.write(scraped.title ? ' 완료\n' : ' 실패 (직접 입력)\n');

    // 3. 상품명
    const title = await prompt(rl, '상품명', scraped.title);
    if (!title) { console.log('상품명은 필수입니다.'); process.exit(1); }

    // 4. 카테고리
    console.log('\n카테고리:');
    CATEGORIES.forEach((c, i) => console.log(`  ${i + 1}. ${c}`));
    const catNum = parseInt(await prompt(rl, '번호 선택', '10'), 10);
    const cat = CATEGORIES[(catNum - 1) % CATEGORIES.length] || CATEGORIES[CATEGORIES.length - 1];

    // 5. 가격
    const priceStr = await prompt(rl, '딜 가격 (USD)', scraped.price?.toString() ?? '');
    const price = parseFloat(priceStr) || null;

    const origStr = await prompt(rl, '정가 (USD, 없으면 엔터');
    const original = parseFloat(origStr) || null;

    // 6. 이미지
    console.log('\n이미지 방법 선택:');
    console.log('  1. 로컬 파일 업로드');
    if (scraped.img) console.log(`  2. Amazon 이미지 사용 (${scraped.img.slice(0, 60)}...)`);
    console.log(`  ${scraped.img ? '3' : '2'}. 직접 URL 입력`);

    const imgChoice = (await rl.question('선택: ')).trim();
    const timestamp = Date.now();
    const baseFilename = `deal_${timestamp}`;
    let imgUrl = '';

    if (imgChoice === '1') {
      const localPath = (await rl.question('파일 경로: ')).trim();
      if (!fs.existsSync(localPath)) { console.log('파일을 찾을 수 없습니다.'); process.exit(1); }
      process.stdout.write('업로드 중...');
      imgUrl = await uploadToStorage(localPath, baseFilename);
      console.log(' 완료');
    } else if (imgChoice === '2' && scraped.img) {
      process.stdout.write('이미지 다운로드 및 업로드 중...');
      imgUrl = await downloadImage(scraped.img, baseFilename);
      console.log(' 완료');
    } else {
      const urlInput = (await rl.question('이미지 URL: ')).trim();
      if (urlInput.startsWith('http')) {
        process.stdout.write('다운로드 및 업로드 중...');
        imgUrl = await downloadImage(urlInput, baseFilename);
        console.log(' 완료');
      } else {
        imgUrl = urlInput;
      }
    }

    // 7. 확인
    const discount = original && price ? Math.round((1 - price / original) * 100) : null;
    console.log('\n--- 저장할 내용 ---');
    console.log(`제목     : ${title}`);
    console.log(`카테고리 : ${cat}`);
    console.log(`가격     : $${price}${original ? ` (정가 $${original}, ${discount}% 할인)` : ''}`);
    console.log(`링크     : ${dealLink}`);
    console.log(`이미지   : ${imgUrl}`);

    const ok = (await rl.question('\nSupabase에 저장할까요? (y/n): ')).trim().toLowerCase();
    if (ok !== 'y') { console.log('취소됨.'); return; }

    // 8. Insert
    const { data, error } = await supabase
      .from('deals')
      .insert({ title, cat, store: 'Amazon', price, original, link: dealLink, img: imgUrl })
      .select('id');

    if (error) throw new Error(`DB 저장 실패: ${error.message}`);
    console.log(`\n저장 완료! (id: ${data[0].id})`);

  } catch (err) {
    console.error('\n오류:', err.message);
    process.exit(1);
  } finally {
    rl.close();
  }
}

main();
