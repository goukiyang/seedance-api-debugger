import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';

// Original, synthetic product-use illustrations. No private media or external assets.
const output = new URL('../public/home/', import.meta.url);
await mkdir(output, { recursive: true });
const rect = (x, y, w, h, fill, extra = '') => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" ${extra}/>`;
const landscape = (x, y, w, h) => `<g transform="translate(${x} ${y})"><rect width="${w}" height="${h}" fill="#89cdda"/><circle cx="${w*.8}" cy="${h*.28}" r="${h*.15}" fill="#ffe39b"/><path d="M0 ${h*.8}L${w*.28} ${h*.28}L${w*.6} ${h*.82}L${w*.8} ${h*.48}L${w} ${h*.8}V${h}H0Z" fill="#438b7b"/><path d="M0 ${h*.9}Q${w*.5} ${h*.55} ${w} ${h*.95}V${h}H0Z" fill="#a6d6aa"/></g>`;
const portrait = (x, y, scale = 1) => `<g transform="translate(${x} ${y}) scale(${scale})"><path d="M0 160Q8 105 58 102Q108 105 116 160" fill="#ca5164"/><path d="M46 75H70V118Q58 129 46 118Z" fill="#d5a18d"/><ellipse cx="58" cy="59" rx="32" ry="45" fill="#eac6af"/><path d="M23 60Q14 8 56 8Q100 10 92 66L83 30Q60 48 34 34Z" fill="#313e3e"/><path d="M37 58H47M69 58H79" stroke="#303737" stroke-width="3"/><path d="M57 61L53 78H62M48 91Q58 97 69 90" stroke="#a96867" stroke-width="2" fill="none"/></g>`;
const checker = Array.from({ length: 12 }, (_, row) => Array.from({ length: 20 }, (_, col) => rect(col*32, row*32,32,32,(row+col)%2?'#d1d8dc':'#f0f4f5')).join('')).join('');
const scenes = {
  video: rect(0,0,640,360,'#20343c') + landscape(34,28,572,232) + rect(34,278,572,58,'#151b1e') + [0,1,2,3,4,5].map(i=>landscape(46+i*92,288,80,38)).join('') + '<path d="M282 100L282 177L349 138Z" fill="#fff" opacity=".9"/><path d="M326 275V340" stroke="#ef7778" stroke-width="3"/>',
  canvas: rect(0,0,640,360,'#182b29') + '<path d="M202 110C290 110 276 190 374 190M202 265C290 265 280 190 374 190" fill="none" stroke="#86cbb4" stroke-width="4"/>' + rect(42,32,160,144,'#eff4ef','rx="6"') + landscape(50,40,144,96) + rect(56,148,115,8,'#8ba69b') + rect(42,213,160,110,'#eff4ef','rx="6"') + [0,1,2].map(i=>rect(58,233+i*22,110-i*20,8,'#8ba69b')).join('') + rect(374,68,224,252,'#eff4ef','rx="6"') + landscape(386,80,200,200) + rect(386,294,150,8,'#8ba69b'),
  templates: rect(0,0,640,360,'#2c343d') + [0,1,2].map(i=>`<g transform="translate(${34+i*198} 30)">${rect(0,0,178,300,'#eef3f5','rx="6"')}${i===1?portrait(31,22,.95):landscape(12,12,154,170)}${rect(14,204,116,12,'#7f98a8')}${rect(14,230,148,7,'#b0c4cd')}${rect(14,250,104,7,'#b0c4cd')}${rect(14,276,60,10,'#609d96')}</g>`).join(''),
  avatar: rect(0,0,640,360,'#ccddd8') + rect(34,24,260,312,'#eff5f2','rx="6"') + portrait(55,38,1.9) + rect(320,24,286,312,'#e7eeee','rx="6"') + portrait(349,50,1.65) + '<circle cx="565" cy="60" r="15" fill="#d68c91"/><circle cx="565" cy="104" r="15" fill="#538e81"/>',
  cutout: checker + landscape(24,24,284,312) + portrait(75,65,1.7) + portrait(377,65,1.7) + '<path d="M319 0V360" stroke="#709892" stroke-width="3"/><path d="M369 343V55Q371 27 404 27H526Q573 27 574 66V343" stroke="#28826e" stroke-width="2" stroke-dasharray="7 5" fill="none"/>',
};
for (const [name, scene] of Object.entries(scenes)) await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">${scene}</svg>`)).png().toFile(new URL(`${name}.png`, output).pathname);
