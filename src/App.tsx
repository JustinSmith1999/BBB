import { lazy, Suspense, useEffect, useState } from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { HelmetProvider } from 'react-helmet-async';
import Header from './components/Header';
import Footer from './components/Footer';
import ScrollToTop from './components/ScrollToTop';
// Eager: the LCP target for paid ad traffic.
import LocationTrialSignup from './pages/LocationTrialSignup';
import TrialSuccess from './pages/TrialSuccess';
// Lazy: everything else — split out of the trial-page bundle.
const Home = lazy(() => import('./pages/Home'));
const About = lazy(() => import('./pages/About'));
const FAQ = lazy(() => import('./pages/FAQ'));
const Blog = lazy(() => import('./pages/Blog'));
const Careers = lazy(() => import('./pages/Careers'));
const Franchising = lazy(() => import('./pages/Franchising'));
const Testimonials = lazy(() => import('./pages/Testimonials'));
const Contact = lazy(() => import('./pages/Contact'));
const Locations = lazy(() => import('./pages/Locations'));
const LocationDetail = lazy(() => import('./pages/LocationDetail'));
const Pricing = lazy(() => import('./pages/Pricing'));
const Classes = lazy(() => import('./pages/Classes'));
const ClassDetail = lazy(() => import('./pages/ClassDetail'));
const MyBookings = lazy(() => import('./pages/MyBookings'));
const TrialSignup = lazy(() => import('./pages/TrialSignup'));
const LocationSpecialSignup = lazy(() => import('./pages/LocationSpecialSignup'));
const LocationSchedule = lazy(() => import('./pages/LocationSchedule'));
const Terms = lazy(() => import('./pages/Terms'));
const Privacy = lazy(() => import('./pages/Privacy'));
const Legal = lazy(() => import('./pages/Legal'));

function ScrollProgress() {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const onScroll = () => {
      const el = document.documentElement;
      const total = el.scrollHeight - el.clientHeight;
      setWidth(total > 0 ? (el.scrollTop / total) * 100 : 0);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  return <div id="scroll-progress" style={{ width: `${width}%` }} />;
}

function App() {
  return (
    <HelmetProvider>
    <Router>
      <div className="min-h-screen" style={{ backgroundColor: 'var(--bg-primary)' }}>
        <ScrollProgress />
        <ScrollToTop />
        <Header />
        <Suspense fallback={null}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/about" element={<About />} />
          <Route path="/faq" element={<FAQ />} />
          <Route path="/blog" element={<Blog />} />
          <Route path="/careers" element={<Careers />} />
          <Route path="/franchising" element={<Franchising />} />
          <Route path="/testimonials" element={<Testimonials />} />
          <Route path="/contact" element={<Contact />} />
          <Route path="/locations" element={<Locations />} />
          <Route path="/locations/:slug" element={<LocationDetail />} />
          <Route path="/pricing" element={<Pricing />} />
          <Route path="/classes" element={<Classes />} />
          <Route path="/classes/:id" element={<ClassDetail />} />
          <Route path="/bookings" element={<MyBookings />} />
          <Route path="/trial" element={<TrialSignup />} />
          <Route path="/trial/:location" element={<LocationTrialSignup />} />
          <Route path="/special/:location" element={<LocationSpecialSignup />} />
          <Route path="/schedule/:location" element={<LocationSchedule />} />
          <Route path="/trial-success" element={<TrialSuccess />} />
          <Route path="/terms" element={<Terms />} />
          <Route path="/privacy" element={<Privacy />} />
          <Route path="/legal" element={<Legal />} />
        </Routes>
        </Suspense>
        <Footer />
      </div>
    </Router>
    </HelmetProvider>
  );
}

export default App;
