// 背景：Workspace 曾独立维护 v1 ProjectRegistry/Workset reader。
// 目的：所有 Workspace consumer 直接共享 final-v0.3 严格持久 schema。
// 上下文：此文件仅保留稳定模块路径，不转换、补默认值或接受旧字段。
export * from '../domain/workset.js';
