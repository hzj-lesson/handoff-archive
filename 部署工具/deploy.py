#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
通用 GitHub 部署工具（Git Data API: blob -> tree -> commit -> ref）
适用于 hzj-lesson 名下所有 GitHub Pages 仓库。

用法：
  # 部署单个文件
  python3 deploy.py --repo hzj-lesson/bigdata-excel-contest \
                    --map /workspace/index.html=index.html \
                    --msg "fix: 修复某某问题"

  # 一次部署多个文件
  python3 deploy.py --repo hzj-lesson/handoff-archive \
                    --map /workspace/index.html=bigdata-excel-contest/index.html \
                    --map /workspace/交接报告.md=交接报告.md \
                    --msg "chore: 归档"

  # 只检查线上状态，不部署
  python3 deploy.py --repo hzj-lesson/bigdata-excel-contest --check-only

Token 来源（按优先级）：
  1. --token 参数
  2. 环境变量 GITHUB_TOKEN
  3. /tmp/gh_token 文件
"""
import argparse, base64, json, os, sys, time, urllib.request, urllib.error, urllib.parse

HDR = {'Accept': 'application/vnd.github+json', 'User-Agent': 'deploy-tool',
       'Connection': 'close'}   # 沙箱网络需 Connection: close 绕过 keep-alive 故障


def get_token(cli_token):
    if cli_token:
        return cli_token
    if os.environ.get('GITHUB_TOKEN'):
        return os.environ['GITHUB_TOKEN']
    for p in ('/tmp/gh_token', os.path.expanduser('~/.gh_token')):
        if os.path.exists(p):
            return open(p).read().strip()
    sys.exit('❌ 找不到 GitHub token：用 --token 传入，或写入 /tmp/gh_token')


class GH:
    def __init__(self, repo, token):
        self.api = 'https://api.github.com/repos/%s' % repo
        self.h = dict(HDR)
        self.h['Authorization'] = 'Bearer ' + token

    @staticmethod
    def enc(path):
        """仓库内路径需要 URL 编码，否则中文文件名（如 交接报告.md）会让请求直接崩在 ascii 编码上"""
        return urllib.parse.quote(path, safe='/')

    def req(self, url, data=None, method=None, retries=5):
        last = None
        for i in range(retries):
            try:
                r = urllib.request.Request(url, data=data, headers=self.h, method=method)
                with urllib.request.urlopen(r, timeout=90) as resp:
                    return json.loads(resp.read().decode('utf-8'))
            except urllib.error.HTTPError as e:
                body = e.read().decode('utf-8', 'ignore')
                last = 'HTTP %s: %s' % (e.code, body[:300])
                if e.code == 429 or e.code >= 500:
                    wait = 15 if e.code == 429 else 5
                    print('   ⏳ %s，%ss 后重试 (%d/%d)' % (e.code, wait, i + 1, retries))
                    time.sleep(wait)
                    continue
                sys.exit('❌ ' + last)
            except Exception as e:
                last = str(e)
                print('   ⏳ 网络错误：%s，5s 后重试 (%d/%d)' % (last[:80], i + 1, retries))
                time.sleep(5)
        sys.exit('❌ 重试耗尽：' + str(last))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--repo', required=True, help='owner/repo，如 hzj-lesson/bigdata-excel-contest')
    ap.add_argument('--map', action='append', default=[], help='本地路径=仓库内路径，可多次传入')
    ap.add_argument('--msg', default='chore: update via deploy.py')
    ap.add_argument('--branch', default='main')
    ap.add_argument('--token', default=None)
    ap.add_argument('--check-only', action='store_true', help='只查看线上状态，不部署')
    a = ap.parse_args()

    gh = GH(a.repo, get_token(a.token))

    # --- 线上当前状态 ---
    head = gh.req(gh.api + '/git/refs/heads/%s' % a.branch)
    base_sha = head['object']['sha']
    print('仓库      : %s' % a.repo)
    print('线上 HEAD : %s' % base_sha[:8])

    if a.check_only:
        for m in a.map:
            local, path = (m.split('=', 1) + [None])[:2]
            path = path or os.path.basename(local)
            info = gh.req(gh.api + '/contents/%s?ref=%s' % (gh.enc(path), a.branch))
            lb = os.path.getsize(local)
            print('  %-40s 线上 %-10d 本地 %-10d %s'
                  % (path, info['size'], lb, '✅ 一致' if info['size'] == lb else '⚠️ 不一致'))
        return

    if not a.map:
        sys.exit('❌ 请用 --map 本地路径=仓库路径 指定要部署的文件')

    # --- 逐个建 blob ---
    tree = []
    for m in a.map:
        local, path = (m.split('=', 1) + [None])[:2]
        path = path or os.path.basename(local)
        if not os.path.exists(local):
            sys.exit('❌ 本地文件不存在：' + local)
        content = open(local, 'rb').read()
        blob = gh.req(gh.api + '/git/blobs',
                      json.dumps({'content': base64.b64encode(content).decode(),
                                  'encoding': 'base64'}).encode(), 'POST')
        tree.append({'path': path, 'mode': '100644', 'type': 'blob', 'sha': blob['sha']})
        print('  📦 %-40s %8d 字节 -> blob %s' % (path, len(content), blob['sha'][:8]))

    # --- 建 tree / commit / 移动 ref ---
    base_tree = gh.req(gh.api + '/git/commits/' + base_sha)['tree']['sha']
    new_tree = gh.req(gh.api + '/git/trees',
                      json.dumps({'base_tree': base_tree, 'tree': tree}).encode(), 'POST')
    commit = gh.req(gh.api + '/git/commits',
                    json.dumps({'message': a.msg, 'tree': new_tree['sha'],
                                'parents': [base_sha]}).encode(), 'POST')
    gh.req(gh.api + '/git/refs/heads/%s' % a.branch,
           json.dumps({'sha': commit['sha']}).encode(), 'PATCH')
    print('✅ 已部署 commit: %s' % commit['sha'])

    # --- 校验：必须用 git/blobs 的 size 字段 ---
    print('--- 校验 ---')
    ok = True
    for m in a.map:
        local, path = (m.split('=', 1) + [None])[:2]
        path = path or os.path.basename(local)
        lb = os.path.getsize(local)
        info = gh.req(gh.api + '/contents/%s?ref=%s' % (gh.enc(path), a.branch))
        same = info['size'] == lb
        ok = ok and same
        print('  %-40s 线上 %-9d 本地 %-9d %s' % (path, info['size'], lb, '✅' if same else '❌ 不一致'))
    print('结果：%s' % ('✅ 全部一致，部署完整' if ok else '❌ 有文件不一致，请重新部署'))
    if ok:
        print('🌐 Pages 约 1–2 分钟后自动重建生效')


if __name__ == '__main__':
    main()
