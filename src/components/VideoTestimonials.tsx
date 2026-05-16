import { useEffect, useState } from 'react';
import { Play } from 'lucide-react';
import { Testimonial } from '../lib/supabase';

interface VideoTestimonialsProps {
  testimonials: Testimonial[];
  title?: string;
  subtitle?: string;
  maxVideos?: number;
}

export default function VideoTestimonials({
  testimonials,
  title = 'Success Stories',
  subtitle = 'Hear from our amazing members',
  maxVideos = 6
}: VideoTestimonialsProps) {
  const [selectedVideo, setSelectedVideo] = useState<string | null>(null);
  const videoTestimonials = testimonials.filter(t => t.video_url).slice(0, maxVideos);

  const getYouTubeEmbedUrl = (url: string) => {
    if (url.includes('youtube.com/watch')) {
      const videoId = url.split('v=')[1]?.split('&')[0];
      return `https://www.youtube.com/embed/${videoId}`;
    }
    if (url.includes('youtu.be/')) {
      const videoId = url.split('youtu.be/')[1]?.split('?')[0];
      return `https://www.youtube.com/embed/${videoId}`;
    }
    if (url.includes('youtube.com/embed/')) {
      return url;
    }
    return url;
  };

  const getYouTubeThumbnail = (url: string) => {
    let videoId = '';
    if (url.includes('youtube.com/watch')) {
      videoId = url.split('v=')[1]?.split('&')[0] || '';
    } else if (url.includes('youtu.be/')) {
      videoId = url.split('youtu.be/')[1]?.split('?')[0] || '';
    } else if (url.includes('youtube.com/embed/')) {
      videoId = url.split('embed/')[1]?.split('?')[0] || '';
    }
    return videoId ? `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg` : '';
  };

  useEffect(() => {
    if (selectedVideo) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = 'unset';
    }
    return () => {
      document.body.style.overflow = 'unset';
    };
  }, [selectedVideo]);

  if (videoTestimonials.length === 0) {
    return null;
  }

  return (
    <>
      <section className="py-12 sm:py-16 lg:py-20 bg-gradient-to-b from-black to-gray-900">
        <div className="container mx-auto px-4">
          <div className="text-center mb-10 sm:mb-16">
            <h2 className="text-[clamp(1.75rem,6vw,5rem)] font-black text-white mb-3 sm:mb-4 tracking-tight leading-tight">
              {title}
            </h2>
            <div className="h-1 sm:h-1.5 w-16 sm:w-20 bg-red-600 rounded-full mx-auto mb-4 sm:mb-6" />
            <p className="text-lg sm:text-xl text-gray-400">{subtitle}</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 sm:gap-8 max-w-7xl mx-auto">
            {videoTestimonials.map((testimonial) => (
              <div
                key={testimonial.id}
                className="group relative bg-gradient-to-br from-gray-900 to-black rounded-xl sm:rounded-2xl overflow-hidden shadow-2xl cursor-pointer transform transition-all duration-300 hover:scale-105 hover:shadow-red-600/20"
                onClick={() => setSelectedVideo(testimonial.video_url)}
              >
                <div className="relative aspect-video">
                  <img
                    src={testimonial.video_thumbnail || getYouTubeThumbnail(testimonial.video_url!)}
                    alt={testimonial.title}
                    className="w-full h-full object-cover"
                    onError={(e) => {
                      (e.target as HTMLImageElement).src = getYouTubeThumbnail(testimonial.video_url!);
                    }}
                  />
                  <div className="absolute inset-0 bg-black/40 group-hover:bg-black/60 transition-all duration-300 flex items-center justify-center">
                    <div className="bg-red-600 rounded-full p-4 sm:p-6 transform transition-all duration-300 group-hover:scale-110 group-hover:bg-red-700 shadow-2xl">
                      <Play className="w-6 h-6 sm:w-8 sm:h-8 text-white fill-white" />
                    </div>
                  </div>
                </div>

                <div className="p-4 sm:p-6">
                  <h3 className="text-lg sm:text-xl font-bold text-white mb-2 line-clamp-2">
                    {testimonial.title}
                  </h3>
                  <p className="text-red-600 font-bold text-base sm:text-lg">
                    {testimonial.name}
                  </p>
                  {testimonial.content && (
                    <p className="text-gray-400 mt-2 sm:mt-3 line-clamp-2 text-sm">
                      {testimonial.content}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {selectedVideo && (
        <div
          className="fixed inset-0 bg-black/95 z-50 flex items-center justify-center p-4 animate-fadeIn"
          onClick={() => setSelectedVideo(null)}
        >
          <div
            className="relative w-full max-w-6xl aspect-video bg-black rounded-lg sm:rounded-2xl overflow-hidden shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setSelectedVideo(null)}
              className="absolute top-2 right-2 sm:top-4 sm:right-4 z-10 bg-red-600 hover:bg-red-700 text-white rounded-full p-2 sm:p-3 transition-all transform hover:scale-110 shadow-lg"
              aria-label="Close video"
            >
              <svg
                className="w-5 h-5 sm:w-6 sm:h-6"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
            <iframe
              src={`${getYouTubeEmbedUrl(selectedVideo)}?autoplay=1`}
              className="w-full h-full"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
              title="Video testimonial"
            />
          </div>
        </div>
      )}
    </>
  );
}
