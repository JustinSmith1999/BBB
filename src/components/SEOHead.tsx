import { Helmet } from 'react-helmet-async';
import { buildTitle, buildCanonical, DEFAULT_OG_IMAGE, SITE_NAME } from '../lib/seo';

interface SEOHeadProps {
  title: string;
  description: string;
  canonical?: string;
  ogImage?: string;
  ogType?: string;
  noindex?: boolean;
  schema?: object | object[];
}

export default function SEOHead({
  title,
  description,
  canonical,
  ogImage = DEFAULT_OG_IMAGE,
  ogType = 'website',
  noindex = false,
  schema,
}: SEOHeadProps) {
  const fullTitle = buildTitle(title);
  const canonicalUrl = buildCanonical(canonical);
  const schemaStr = schema
    ? JSON.stringify(Array.isArray(schema) ? schema : [schema])
    : null;

  return (
    <Helmet>
      <title>{fullTitle}</title>
      <meta name="description" content={description} />
      <meta name="robots" content={noindex ? 'noindex,nofollow' : 'index,follow'} />
      <link rel="canonical" href={canonicalUrl} />

      <meta property="og:title" content={fullTitle} />
      <meta property="og:description" content={description} />
      <meta property="og:image" content={ogImage} />
      <meta property="og:type" content={ogType} />
      <meta property="og:url" content={canonicalUrl} />
      <meta property="og:site_name" content={SITE_NAME} />
      <meta property="og:locale" content="en_US" />

      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={fullTitle} />
      <meta name="twitter:description" content={description} />
      <meta name="twitter:image" content={ogImage} />

      {schemaStr && (
        <script type="application/ld+json">{schemaStr}</script>
      )}
    </Helmet>
  );
}
