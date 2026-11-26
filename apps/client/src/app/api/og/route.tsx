import { ImageResponse } from 'next/og';
import type { NextRequest } from 'next/server';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const owner = searchParams.get('owner') || 'OpenGits';
  const repo = searchParams.get('repo') || 'Knowledge';
  const title = searchParams.get('title') || 'Interactive Documentation';
  const model = searchParams.get('model') || null;

  const displayTitle = title.length > 55 ? `${title.slice(0, 52)}...` : title;
  const isZh = /[\u4e00-\u9fa5]/.test(title) || /[\u4e00-\u9fa5]/.test(repo);
  const modelBadge = model ? (isZh ? `${model} 讲法` : `${model} Edition`) : null;
  const subtitle = isZh
    ? '结构化导读 · 交互式源码拓扑 · 开源知识库'
    : 'Structured Digest · Code Topology · Open Knowledge';
  const host = req.headers.get('host') || 'opengits.com';

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '64px 72px',
          backgroundColor: 'rgb(12, 13, 18)',
          backgroundImage:
            'radial-gradient(circle at 85% 15%, rgba(56, 189, 248, 0.12) 0%, transparent 45%), radial-gradient(circle at 15% 85%, rgba(139, 92, 246, 0.08) 0%, transparent 40%)',
          color: 'rgb(245, 245, 247)',
          fontFamily:
            '"WenQuanYi Zen Hei", "Noto Sans CJK SC", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
          boxSizing: 'border-box',
          border: '1px solid rgb(35, 38, 48)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            width: '100%',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
            <div
              style={{
                width: '40px',
                height: '40px',
                borderRadius: '10px',
                backgroundColor: 'rgb(255, 255, 255)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'rgb(12, 13, 18)',
                fontWeight: 900,
                fontSize: '22px',
              }}
            >
              O
            </div>
            <span
              style={{
                fontSize: '26px',
                fontWeight: 700,
                letterSpacing: '-0.02em',
                color: 'rgb(255, 255, 255)',
              }}
            >
              OpenGits
            </span>
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '8px 18px',
              borderRadius: '9999px',
              backgroundColor: 'rgba(255, 255, 255, 0.06)',
              border: '1px solid rgba(255, 255, 255, 0.12)',
              fontSize: '18px',
              fontWeight: 500,
              color: 'rgb(200, 205, 218)',
            }}
          >
            <span>{owner}</span>
            <span style={{ color: 'rgba(255, 255, 255, 0.4)' }}>/</span>
            <span style={{ fontWeight: 700, color: 'rgb(255, 255, 255)' }}>{repo}</span>
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '16px',
            maxWidth: '1020px',
            marginTop: '20px',
            marginBottom: '20px',
          }}
        >
          {modelBadge ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                alignSelf: 'flex-start',
                padding: '6px 14px',
                borderRadius: '6px',
                backgroundColor: 'rgba(56, 189, 248, 0.12)',
                border: '1px solid rgba(56, 189, 248, 0.28)',
                color: 'rgb(56, 189, 248)',
                fontSize: '15px',
                fontWeight: 600,
                letterSpacing: '0.04em',
                textTransform: 'uppercase',
              }}
            >
              <span>●</span>
              <span>{modelBadge}</span>
            </div>
          ) : null}

          <div
            style={{
              fontSize: displayTitle.length > 30 ? '46px' : '56px',
              fontWeight: 800,
              lineHeight: 1.18,
              color: 'rgb(255, 255, 255)',
              letterSpacing: '-0.03em',
              wordBreak: 'break-word',
            }}
          >
            {displayTitle}
          </div>

          <div
            style={{
              fontSize: '22px',
              lineHeight: 1.4,
              color: 'rgb(150, 156, 175)',
              fontWeight: 400,
            }}
          >
            {subtitle}
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderTop: '1px solid rgba(255, 255, 255, 0.08)',
            paddingTop: '24px',
            width: '100%',
          }}
        >
          <div
            style={{
              fontSize: '18px',
              fontWeight: 500,
              color: 'rgb(120, 126, 145)',
              letterSpacing: '0.02em',
            }}
          >
            {host}
          </div>
          <div
            style={{
              fontSize: '16px',
              fontWeight: 400,
              color: 'rgb(100, 106, 125)',
            }}
          >
            AI-Ready Knowledge Hub for Humans &amp; Agents
          </div>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
      headers: {
        'content-type': 'image/png',
        'cache-control': 'public, max-age=86400, stale-while-revalidate=604800',
      },
    }
  );
}
