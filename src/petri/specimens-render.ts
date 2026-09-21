/**
 * 前端只读的标本渲染形态表。
 *
 * 注意：这里只是「怎么画」的视觉参数，与模拟结果无关。
 * 模拟权威在服务端，修改本文件不会改变任何细胞数量、指纹或演替结果。
 * 形态（杆/球/弧/酵母/菌丝/二十面体/包膜）与服务端 SpecimenTrait.shape 对应。
 */
import type { MicrobeCategory } from '../../shared/types';

export type RenderShape =
  | 'rod'
  | 'coccus'
  | 'curved'
  | 'yeast'
  | 'hypha'
  | 'icosahedron'
  | 'filament'
  | 'enveloped'
  | 'coccal';

export interface RenderSpecimen {
  id: number;
  category: MicrobeCategory;
  shape: RenderShape;
  /** 基础着色（暗）与发光色（亮），手绘渐变用 */
  base: string;
  glow: string;
  /** 是否长鞭毛（前端画波形鞭毛） */
  flagella: number; // 鞭毛条数 0..8
  label: string;
}

const C = {
  bacteria: { base: '#0a8f74', glow: '#5fffe0' },
  fungi: { base: '#6e3b8c', glow: '#c79bff' },
  virus: { base: '#a52b22', glow: '#ff8a7a' },
  archaea: { base: '#9c7f12', glow: '#ffe66d' },
};

function v(id: number, category: MicrobeCategory, shape: RenderShape, label: string, flagella = 0): RenderSpecimen {
  return { id, category, shape, base: C[category].base, glow: C[category].glow, flagella, label };
}

export const RENDER_SPECIMENS: RenderSpecimen[] = [
  v(1, 'bacteria', 'rod', '大肠杆菌', 6),
  v(2, 'bacteria', 'coccus', '金黄色葡萄球菌', 0),
  v(3, 'bacteria', 'rod', '枯草芽孢杆菌', 5),
  v(4, 'bacteria', 'rod', '铜绿假单胞菌', 1),
  v(5, 'bacteria', 'rod', '嗜酸乳杆菌', 0),
  v(6, 'bacteria', 'rod', '结核分枝杆菌', 0),
  v(7, 'bacteria', 'curved', '霍乱弧菌', 1),
  v(8, 'bacteria', 'rod', '双歧杆菌', 0),
  v(9, 'fungi', 'yeast', '酿酒酵母', 0),
  v(10, 'fungi', 'hypha', '黑曲霉', 0),
  v(11, 'fungi', 'hypha', '产黄青霉', 0),
  v(12, 'fungi', 'yeast', '白色念珠菌', 0),
  v(13, 'fungi', 'hypha', '双孢蘑菇', 0),
  v(14, 'fungi', 'hypha', '灵芝', 0),
  v(15, 'virus', 'icosahedron', 'T4噬菌体', 0),
  v(16, 'virus', 'filament', '烟草花叶病毒', 0),
  v(17, 'virus', 'enveloped', '流感病毒', 0),
  v(18, 'virus', 'enveloped', '新冠病毒', 0),
  v(19, 'virus', 'enveloped', 'HIV', 0),
  v(20, 'virus', 'icosahedron', '腺病毒', 0),
  v(21, 'archaea', 'coccal', '詹氏甲烷球菌', 4),
  v(22, 'archaea', 'coccal', '嗜酸热硫化叶菌', 3),
  v(23, 'archaea', 'rod', '盐生盐杆菌', 2),
  v(24, 'archaea', 'coccal', '激烈火球菌', 5),
];

const BY_ID = new Map(RENDER_SPECIMENS.map((s) => [s.id, s]));
export function renderSpecimen(id: number): RenderSpecimen {
  return BY_ID.get(id) ?? RENDER_SPECIMENS[0];
}
