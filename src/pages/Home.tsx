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
        title="Better Body Bootcamp | NYC's #1 Group Fitness Since 2011"
        description="Transform your body and your life at Better Body Bootcamp. High-energy group training across 4 NYC locations — Astoria, Bayside, Fresh Meadows, Williamsburg. Start your 2-week trial for $49."
        canonical="/"
        schema={[organizationSchema, websiteSchema]}
      />
      <Hero />
      <BrandPillars />
      <TrialForm />
    </>
  );
}
