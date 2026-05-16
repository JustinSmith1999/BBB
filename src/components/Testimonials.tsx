import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Quote } from 'lucide-react';
import { supabase, Testimonial } from '../lib/supabase';

export default function Testimonials() {
  const [testimonials, setTestimonials] = useState<Testimonial[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchTestimonials();
  }, []);

  const fetchTestimonials = async () => {
    try {
      const { data, error } = await supabase
        .from('testimonials')
        .select('*')
        .eq('is_featured', true)
        .order('display_order');

      if (error) throw error;
      setTestimonials(data || []);
    } catch (error) {
      console.error('Error fetching testimonials:', error);
    } finally {
      setLoading(false);
    }
  };

  const nextTestimonial = () => {
    setCurrentIndex((prev) => (prev + 1) % testimonials.length);
  };

  const prevTestimonial = () => {
    setCurrentIndex((prev) => (prev - 1 + testimonials.length) % testimonials.length);
  };

  if (loading) {
    return (
      <section id="testimonials" className="py-16 bg-black text-white">
        <div className="container mx-auto px-4 text-center">
          <p className="text-xl">Loading testimonials...</p>
        </div>
      </section>
    );
  }

  if (testimonials.length === 0) {
    return null;
  }

  const currentTestimonial = testimonials[currentIndex];

  const extractYouTubeId = (url: string) => {
    const regExp = /^.*((youtu.be\/)|(v\/)|(\/u\/\w\/)|(embed\/)|(watch\?))\??v?=?([^#&?]*).*/;
    const match = url.match(regExp);
    return (match && match[7].length === 11) ? match[7] : null;
  };

  return (
    <section id="testimonials" className="py-12 sm:py-16 bg-black text-white">
      <div className="container mx-auto px-4">
        <div className="text-center mb-8 sm:mb-12">
          <h2 className="text-[clamp(1.75rem,5vw,5rem)] font-bold mb-3 sm:mb-4">
            Success Stories
          </h2>
          <p className="text-lg sm:text-xl text-gray-400">
            Real People, Real Results
          </p>
        </div>

        <div className="max-w-4xl mx-auto">
          <div className="bg-gradient-to-br from-gray-900 to-black border border-gray-800 rounded-2xl p-6 sm:p-8 md:p-12 shadow-2xl">
            {currentTestimonial.video_url ? (
              <div className="mb-6 sm:mb-8">
                <div className="relative w-full" style={{ paddingBottom: '56.25%' }}>
                  <iframe
                    className="absolute top-0 left-0 w-full h-full rounded-lg"
                    src={`https://www.youtube.com/embed/${extractYouTubeId(currentTestimonial.video_url)}`}
                    title={currentTestimonial.title}
                    frameBorder="0"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                    allowFullScreen
                  ></iframe>
                </div>
              </div>
            ) : (
              <Quote className="w-12 h-12 sm:w-16 sm:h-16 text-red-600 mb-4 sm:mb-6 mx-auto" />
            )}

            <h3 className="text-[clamp(1.25rem,4vw,3rem)] font-bold mb-4 sm:mb-6 text-center">
              {currentTestimonial.title}
            </h3>

            {currentTestimonial.content && (
              <p className="text-base sm:text-lg md:text-xl text-gray-300 mb-6 sm:mb-8 leading-relaxed text-center">
                {currentTestimonial.content}
              </p>
            )}

            <div className="text-center">
              <p className="text-xl sm:text-2xl font-bold text-red-600">
                {currentTestimonial.name}
              </p>
            </div>
          </div>

          <div className="flex justify-center items-center mt-6 sm:mt-8 space-x-3 sm:space-x-4">
            <button
              onClick={prevTestimonial}
              className="bg-red-600 hover:bg-red-700 p-2.5 sm:p-3 rounded-full transition-all transform hover:scale-110"
              aria-label="Previous testimonial"
            >
              <ChevronLeft className="w-5 h-5 sm:w-6 sm:h-6" />
            </button>

            <div className="flex space-x-2">
              {testimonials.map((_, index) => (
                <button
                  key={index}
                  onClick={() => setCurrentIndex(index)}
                  className={`w-2.5 h-2.5 sm:w-3 sm:h-3 rounded-full transition-all ${
                    index === currentIndex ? 'bg-red-600 w-6 sm:w-8' : 'bg-gray-600'
                  }`}
                  aria-label={`Go to testimonial ${index + 1}`}
                />
              ))}
            </div>

            <button
              onClick={nextTestimonial}
              className="bg-red-600 hover:bg-red-700 p-2.5 sm:p-3 rounded-full transition-all transform hover:scale-110"
              aria-label="Next testimonial"
            >
              <ChevronRight className="w-5 h-5 sm:w-6 sm:h-6" />
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
