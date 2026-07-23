import Hero from '../components/Hero';
import BrandPillars from '../components/BrandPillars';
import TrialForm from '../components/TrialForm';
import SEOHead from '../components/SEOHead';

const organizationSchema = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'Better Body Bootcamp',
  url: 'https://betterbodybootcamp.com',
  logo: 'https://uracuwugpxqjfgtuobal.supabase.co/storage/v1/object/public/logos/cropped-0140_bbb_newstrike_logo-design_black_1.png',
  sameAs: [
    'https://www.instagram.com/betterbodybootcamp',
    'https://www.facebook.com/betterbodybootcamp',
  ],
};

const websiteSchema = {
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  name: 'Better Body Bootcamp',
  url: 'https://betterbodybootcamp.com',
};

export default function Home() {
  return (
    <>
      <SEOHead
        title="Best Gyms in Queens & NYC | Better Body Bootcamp · 4 Locations"
        description="The #1 group fitness gyms in Queens and NYC. Three Better Body Bootcamp studios in Queens (Astoria, Bayside, Fresh Meadows) plus Williamsburg, Brooklyn. Real strength training, expert coaches, 2-week trial for $49."
        canonical="/"
        schema={[organizationSchema, websiteSchema]}
      />
      <Hero />
      <BrandPillars />
      <TrialForm />
    </>
  );
}
