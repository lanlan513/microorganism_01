/**
 * 培养皿世界常量 —— 浏览器与服务端共享，禁止引用 node: 内置模块。
 * 服务端引擎从此处读取；前端渲染器也只用这一处的几何常数。
 */
export const WORLD_RADIUS = 500;
export const GRID_N = 40;
export const CELL_SIZE = (WORLD_RADIUS * 2) / GRID_N;
