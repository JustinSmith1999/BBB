import { useEffect, useState } from 'react';
import { Calendar, User, ArrowRight } from 'lucide-react';
import { supabase } from '../lib/supabase';
import SEOHead from '../components/SEOHead';

interface BlogPost {
  id: string;
  title: string;
  slug: string;
  excerpt: string;
  image_url: string | null;
  author: string;
  published_at: string;
}

export default function Blog() {
  const [posts, setPosts] = useState<BlogPost[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchPosts();
  }, []);

  const fetchPosts = async () => {
    try {
      const { data, error } = await supabase
        .from('blog_posts')
        .select('id, title, slug, excerpt, image_url, author, published_at')
        .eq('published', true)
        .order('published_at', { ascending: false });

      if (error) throw error;
      setPosts(data || []);
    } catch (error) {
      console.error('Error fetching blog posts:', error);
    } finally {
      setLoading(false);
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  };

  return (
    <>
    <SEOHead
      title="Blog | Better Body Bootcamp"
      description="Fitness tips, workout insights, nutrition advice, and success stories from Better Body Bootcamp — New York's premier group fitness community."
      canonical="/blog"
    />
    <div className="min-h-screen bg-white">
      <div className="bg-gradient-to-br from-black to-gray-900 text-white pt-24 pb-20">
        <div className="container mx-auto px-4 text-center">
          <h1 className="text-[clamp(2.5rem,7vw,6rem)] font-bold mb-6">
            Better Body <span className="text-red-600">Blog</span>
          </h1>
          <p className="text-xl md:text-2xl text-gray-300 max-w-3xl mx-auto">
            Tips, insights, and inspiration for your fitness journey
          </p>
        </div>
      </div>

      <div className="container mx-auto px-4 py-16">
        {loading ? (
          <div className="text-center py-12">
            <p className="text-xl text-gray-600">Loading posts...</p>
          </div>
        ) : posts.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-xl text-gray-600">No blog posts yet. Check back soon!</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
            {posts.map((post) => (
              <article
                key={post.id}
                className="bg-white rounded-xl shadow-lg overflow-hidden hover:shadow-2xl transition-all transform hover:-translate-y-2"
              >
                <div className="aspect-video bg-gradient-to-br from-red-600 to-red-800 flex items-center justify-center">
                  {post.image_url ? (
                    <img
                      src={post.image_url}
                      alt={post.title}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="text-white text-4xl font-bold">BBB</div>
                  )}
                </div>
                <div className="p-6">
                  <div className="flex items-center space-x-4 text-sm text-gray-500 mb-3">
                    <div className="flex items-center space-x-1">
                      <Calendar className="w-4 h-4" />
                      <span>{formatDate(post.published_at)}</span>
                    </div>
                    <div className="flex items-center space-x-1">
                      <User className="w-4 h-4" />
                      <span>{post.author}</span>
                    </div>
                  </div>
                  <h2 className="text-2xl font-bold mb-3 text-black hover:text-red-600 transition-colors">
                    {post.title}
                  </h2>
                  <p className="text-gray-700 leading-relaxed mb-4">{post.excerpt}</p>
                  <button className="inline-flex items-center space-x-2 text-red-600 hover:text-red-700 font-bold transition-colors">
                    <span>Read More</span>
                    <ArrowRight className="w-4 h-4" />
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      <div className="bg-gray-50 py-16">
        <div className="container mx-auto px-4 text-center">
          <h2 className="text-[clamp(1.75rem,4vw,4rem)] font-bold mb-6 text-black">
            Ready to Start Your Journey?
          </h2>
          <p className="text-xl text-gray-700 mb-8 max-w-2xl mx-auto">
            Join thousands of members who have transformed their lives at Better Body Bootcamp
          </p>
          <a
            href="/#trial"
            className="inline-block bg-red-600 hover:bg-red-700 text-white px-10 py-4 rounded-full text-lg font-bold transition-all transform hover:scale-105 shadow-lg"
          >
            Start Your Trial
          </a>
        </div>
      </div>
    </div>
    </>
  );
}
