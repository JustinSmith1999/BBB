import { useEffect, useState } from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { HelmetProvider } from 'react-helmet-async';
import Header from './components/Header';
import Footer from './components/Footer';
import ScrollToTop from './components/ScrollToTop';
import Home from './pages/Home';
import About from './pages/About';
import FAQ from './pages/FAQ';
import Blog from './pages/Blog';
import Careers from './pages/Careers';
import Franchising from './pages/Franchising';
import Testimonials from './pages/Testimonials';
import Contact from './pages/Contact';
import Locations from './pages/Locations';
import LocationDetail from './pages/LocationDetail';
import Pricing from './pages/Pricing';
import Classes from './pages/Classes';
import ClassDetail from './pages/ClassDetail';
import MyBookings from './pages/MyBookings';
import TrialSignup from './pages/TrialSignup';
import LocationTrialSignup from './pages/LocationTrialSignup';
import TrialSuccess from './pages/TrialSuccess';
import Terms from './pages/Terms';
import Privacy from './pages/Privacy';
import Legal from './pages/Legal';

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
          <Route path="/trial-success" element={<TrialSuccess />} />
          <Route path="/terms" element={<Terms />} />
          <Route path="/privacy" element={<Privacy />} />
          <Route path="/legal" element={<Legal />} />
        </Routes>
        <Footer />
      </div>
    </Router>
    </HelmetProvider>
  );
}

export default App;
