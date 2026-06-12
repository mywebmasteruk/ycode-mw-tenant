/**
 * "Made with MasjidWeb" badge shown on published pages when enabled in settings.
 * MASJIDWEB_SEAM: brand — upstream renders a Ycode wordmark SVG linking to ycode.com;
 * the fork shows the MasjidWeb brand instead. Keep file name/exports upstream-compatible.
 */
export default function YcodeBadge() {
  return (
    <a
      href="https://www.masjidweb.com"
      target="_blank"
      rel="noopener noreferrer"
      aria-label="This website was built using MasjidWeb."
      style={{
        height: 'auto',
        background: '#050606',
        padding: '12px 14px',
        width: 'auto',
        position: 'fixed',
        bottom: '10px',
        right: '10px',
        borderRadius: '8px',
        display: 'flex',
        alignItems: 'center',
        zIndex: 9999,
        opacity: 1,
        color: '#ffffff',
        fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
        fontSize: '12px',
        fontWeight: 600,
        lineHeight: 1,
        textDecoration: 'none',
      }}
    >
      Made with MasjidWeb
    </a>
  );
}
