import { ImageResponse } from 'next/og';

// Apple touch icon — iOS Safari reads this when the user adds the site
// to the home screen. Required by OneSignal's iOS 16.4+ web push setup:
// without an apple-touch-icon the push subscription flow is rejected.
//
// Same brand mark as /icon, rendered at the canonical 180×180 iOS size.

export const runtime = 'edge';
export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

export default function AppleIcon() {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#7c3aed',
        borderRadius: 30,
      }}
    >
      <svg
        width="100"
        height="100"
        viewBox="0 0 24 24"
        fill="none"
        stroke="#ffffff"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    </div>,
    { ...size }
  );
}
