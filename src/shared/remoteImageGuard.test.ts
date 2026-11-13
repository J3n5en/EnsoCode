import { describe, expect, it } from 'vitest';
import { isAllowedRemoteImageUrl, isPrivateOrReservedIp } from './remoteImageGuard';

describe('isPrivateOrReservedIp', () => {
  it('IPv4 内网/环回/链路本地/CGNAT 段视为私有', () => {
    expect(isPrivateOrReservedIp('10.0.0.1')).toBe(true);
    expect(isPrivateOrReservedIp('172.16.0.1')).toBe(true);
    expect(isPrivateOrReservedIp('172.31.255.255')).toBe(true);
    expect(isPrivateOrReservedIp('192.168.1.1')).toBe(true);
    expect(isPrivateOrReservedIp('127.0.0.1')).toBe(true);
    expect(isPrivateOrReservedIp('169.254.169.254')).toBe(true); // 云元数据端点
    expect(isPrivateOrReservedIp('100.64.0.1')).toBe(true);
    expect(isPrivateOrReservedIp('0.0.0.0')).toBe(true);
  });

  it('公网 IPv4 不算私有', () => {
    expect(isPrivateOrReservedIp('8.8.8.8')).toBe(false);
    expect(isPrivateOrReservedIp('1.1.1.1')).toBe(false);
    expect(isPrivateOrReservedIp('172.32.0.1')).toBe(false);
  });

  it('IPv6 环回/链路本地/唯一本地/IPv4 映射视为私有', () => {
    expect(isPrivateOrReservedIp('::1')).toBe(true);
    expect(isPrivateOrReservedIp('fe80::1')).toBe(true);
    expect(isPrivateOrReservedIp('fc00::1')).toBe(true);
    expect(isPrivateOrReservedIp('fd12:3456::1')).toBe(true);
    expect(isPrivateOrReservedIp('::ffff:127.0.0.1')).toBe(true);
  });

  it('公网 IPv6 不算私有', () => {
    expect(isPrivateOrReservedIp('2001:4860:4860::8888')).toBe(false);
  });

  // 审计实测：WHATWG URL 把 [::ffff:127.0.0.1] 规范成 [::ffff:7f00:1]，只认点分形式时两道防线都放行
  it('IPv4 映射地址的十六进制与完整展开写法同样按内嵌 IPv4 判断', () => {
    expect(isPrivateOrReservedIp('::ffff:7f00:1')).toBe(true);
    expect(isPrivateOrReservedIp('::ffff:0:0')).toBe(true);
    expect(isPrivateOrReservedIp('::ffff:a9fe:a9fe')).toBe(true); // 169.254.169.254 云元数据
    expect(isPrivateOrReservedIp('0:0:0:0:0:ffff:7f00:1')).toBe(true);
    expect(isPrivateOrReservedIp('0000:0000:0000:0000:0000:FFFF:0A00:0001')).toBe(true);
    expect(isPrivateOrReservedIp('::ffff:808:808')).toBe(false); // 8.8.8.8 仍放行
  });

  // 背景：IPv4 兼容地址与 NAT64 前缀同样能把私网 IPv4 包进 IPv6 字面量
  it('IPv4 兼容地址与 NAT64 64:ff9b::/96 内嵌私网 IPv4 时视为私有', () => {
    expect(isPrivateOrReservedIp('::7f00:1')).toBe(true);
    expect(isPrivateOrReservedIp('::127.0.0.1')).toBe(true);
    expect(isPrivateOrReservedIp('64:ff9b::a9fe:a9fe')).toBe(true);
    expect(isPrivateOrReservedIp('64:ff9b::10.0.0.1')).toBe(true);
    // 纯 IPv6 网络靠 DNS64 合成 64:ff9b:: 地址访问公网 IPv4，公网目标必须放行
    expect(isPrivateOrReservedIp('64:ff9b::808:808')).toBe(false);
  });

  // 背景：旧实现按字符串前缀只认 fe8x/fe9x，漏掉同属 fe80::/10 的 feax/febx
  it('链路本地 fe80::/10 整段视为私有', () => {
    expect(isPrivateOrReservedIp('fea0::1')).toBe(true);
    expect(isPrivateOrReservedIp('febf:ffff::1')).toBe(true);
  });
});

describe('isAllowedRemoteImageUrl', () => {
  it('放行公网 http/https URL', () => {
    expect(isAllowedRemoteImageUrl('https://img.shields.io/badge.svg')).toBe(true);
    expect(isAllowedRemoteImageUrl('http://example.com/a.png')).toBe(true);
  });

  it('拒绝非 http/https 协议', () => {
    expect(isAllowedRemoteImageUrl('file:///etc/passwd')).toBe(false);
    expect(isAllowedRemoteImageUrl('ftp://example.com/a.png')).toBe(false);
    expect(isAllowedRemoteImageUrl('javascript:alert(1)')).toBe(false);
  });

  it('拒绝 localhost / .local / 字面量内网 IP', () => {
    expect(isAllowedRemoteImageUrl('http://localhost/x.png')).toBe(false);
    expect(isAllowedRemoteImageUrl('http://printer.local/x.png')).toBe(false);
    expect(isAllowedRemoteImageUrl('http://127.0.0.1/x.png')).toBe(false);
    expect(isAllowedRemoteImageUrl('http://169.254.169.254/latest/meta-data/')).toBe(false);
    expect(isAllowedRemoteImageUrl('http://192.168.1.1/x.png')).toBe(false);
    expect(isAllowedRemoteImageUrl('http://[::1]/x.png')).toBe(false);
  });

  // 审计实测：这几种写法都能取回本机服务内容 / 云元数据
  it('拒绝 URL 里写成 IPv4 映射形式的内网地址', () => {
    expect(isAllowedRemoteImageUrl('http://[::ffff:127.0.0.1]/x.png')).toBe(false);
    expect(isAllowedRemoteImageUrl('http://[::ffff:0.0.0.0]/x.png')).toBe(false);
    expect(isAllowedRemoteImageUrl('http://[::ffff:a9fe:a9fe]/latest/meta-data/')).toBe(false);
    expect(isAllowedRemoteImageUrl('http://[0:0:0:0:0:ffff:7f00:1]/x.png')).toBe(false);
  });

  it('拒绝带用户名密码的 URL（防混淆内网跳转）', () => {
    expect(isAllowedRemoteImageUrl('http://user:pass@example.com/x.png')).toBe(false);
  });

  it('解析失败的字符串拒绝', () => {
    expect(isAllowedRemoteImageUrl('not a url')).toBe(false);
    expect(isAllowedRemoteImageUrl('')).toBe(false);
  });
});
