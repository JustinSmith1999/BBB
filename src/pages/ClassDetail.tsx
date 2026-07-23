import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Calendar, Clock, MapPin, Users, ArrowLeft, Info } from 'lucide-react';
import { supabase, LOCATION_PUBLIC_COLUMNS, Class, Location } from '../lib/supabase';
import BookingModal from '../components/BookingModal';

export default function ClassDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [classItem, setClassItem] = useState<Class | null>(null);
  const [location, setLocation] = useState<Location | null>(null);
  const [loading, setLoading] = useState(true);
  const [showBookingModal, setShowBookingModal] = useState(false);

  useEffect(() => {
    if (id) {
      fetchClassDetail();
    }
  }, [id]);

  const fetchClassDetail = async () => {
    setLoading(true);
    try {
      const { data: classData } = await supabase
        .from('classes')
        .select('*')
        .eq('id', id)
        .maybeSingle();

      if (classData) {
        setClassItem(classData);

        const { data: locationData } = await supabase
          .from('locations')
          .select(LOCATION_PUBLIC_COLUMNS)
          .eq('id', classData.location_id)
          .maybeSingle();

        if (locationData) {
          setLocation(locationData);
        }
      }
    } catch (error) {
      console.error('Error fetching class details:', error);
    } finally {
      setLoading(false);
    }
  };

  const formatTime = (datetime: string) => {
    return new Date(datetime).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  };

  const formatDate = (datetime: string) => {
    return new Date(datetime).toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  };

  const getAvailableSpots = () => {
    if (!classItem || !classItem.max_capacity) return null;
    return classItem.max_capacity - classItem.total_booked;
  };

  const handleBookingSuccess = () => {
    setShowBookingModal(false);
    navigate('/bookings');
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 pt-20">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
          <div className="bg-white rounded-lg shadow-sm p-8 animate-pulse">
            <div className="h-8 bg-gray-200 rounded w-3/4 mb-4"></div>
            <div className="h-4 bg-gray-200 rounded w-1/2 mb-8"></div>
            <div className="space-y-4">
              <div className="h-4 bg-gray-200 rounded"></div>
              <div className="h-4 bg-gray-200 rounded"></div>
              <div className="h-4 bg-gray-200 rounded w-5/6"></div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!classItem) {
    return (
      <div className="min-h-screen bg-gray-50 pt-20">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12 text-center">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">Class not found</h2>
          <button
            onClick={() => navigate('/classes')}
            className="text-blue-600 hover:text-blue-700 font-semibold"
          >
            Back to Classes
          </button>
        </div>
      </div>
    );
  }

  const availableSpots = getAvailableSpots();
  const isFull = availableSpots !== null && availableSpots <= 0;

  return (
    <>
      <div className="min-h-screen bg-gray-50 pt-20">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
          <button
            onClick={() => navigate('/classes')}
            className="flex items-center text-gray-600 hover:text-gray-900 mb-6 transition-colors"
          >
            <ArrowLeft className="w-5 h-5 mr-2" />
            Back to Classes
          </button>

          <div className="bg-white rounded-lg shadow-sm overflow-hidden">
            {classItem.image_url && (
              <img
                src={classItem.image_url}
                alt={classItem.name}
                className="w-full h-64 object-cover"
              />
            )}

            <div className="p-8">
              <div className="flex items-start justify-between mb-6">
                <div>
                  <h1 className="text-3xl font-bold text-gray-900 mb-2">
                    {classItem.name}
                  </h1>
                  {classItem.class_type && (
                    <span className="inline-block px-3 py-1 bg-blue-100 text-blue-800 text-sm font-semibold rounded">
                      {classItem.class_type}
                    </span>
                  )}
                </div>
                {classItem.is_virtual && (
                  <span className="px-3 py-1 bg-green-100 text-green-800 text-sm font-semibold rounded">
                    Virtual Class
                  </span>
                )}
              </div>

              {classItem.description && (
                <div className="mb-8">
                  <h2 className="text-lg font-semibold text-gray-900 mb-3">About This Class</h2>
                  <p className="text-gray-700 leading-relaxed">{classItem.description}</p>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
                <div className="space-y-4">
                  <h2 className="text-lg font-semibold text-gray-900">Class Details</h2>

                  <div className="flex items-start">
                    <Calendar className="w-5 h-5 text-gray-600 mr-3 mt-0.5" />
                    <div>
                      <p className="text-sm text-gray-500">Date</p>
                      <p className="text-gray-900 font-medium">
                        {formatDate(classItem.start_datetime)}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-start">
                    <Clock className="w-5 h-5 text-gray-600 mr-3 mt-0.5" />
                    <div>
                      <p className="text-sm text-gray-500">Time</p>
                      <p className="text-gray-900 font-medium">
                        {formatTime(classItem.start_datetime)} - {formatTime(classItem.end_datetime)}
                      </p>
                      {classItem.duration_minutes && (
                        <p className="text-sm text-gray-600">
                          {classItem.duration_minutes} minutes
                        </p>
                      )}
                    </div>
                  </div>

                  {classItem.instructor_name && (
                    <div className="flex items-start">
                      <span className="text-xl mr-3">👤</span>
                      <div>
                        <p className="text-sm text-gray-500">Instructor</p>
                        <p className="text-gray-900 font-medium">{classItem.instructor_name}</p>
                      </div>
                    </div>
                  )}

                  {classItem.level && (
                    <div className="flex items-start">
                      <Info className="w-5 h-5 text-gray-600 mr-3 mt-0.5" />
                      <div>
                        <p className="text-sm text-gray-500">Level</p>
                        <p className="text-gray-900 font-medium">{classItem.level}</p>
                      </div>
                    </div>
                  )}
                </div>

                <div className="space-y-4">
                  <h2 className="text-lg font-semibold text-gray-900">Location & Capacity</h2>

                  {location && (
                    <div className="flex items-start">
                      <MapPin className="w-5 h-5 text-gray-600 mr-3 mt-0.5" />
                      <div>
                        <p className="text-sm text-gray-500">Location</p>
                        <p className="text-gray-900 font-medium">{location.name}</p>
                        <p className="text-sm text-gray-600">
                          {location.address}, {location.city}, {location.state}
                        </p>
                      </div>
                    </div>
                  )}

                  {availableSpots !== null && (
                    <div className="flex items-start">
                      <Users className="w-5 h-5 text-gray-600 mr-3 mt-0.5" />
                      <div>
                        <p className="text-sm text-gray-500">Availability</p>
                        {isFull ? (
                          <p className="text-red-600 font-semibold">Class Full</p>
                        ) : (
                          <p className="text-gray-900 font-medium">
                            {availableSpots} {availableSpots === 1 ? 'spot' : 'spots'} remaining
                          </p>
                        )}
                        <p className="text-sm text-gray-600">
                          {classItem.total_booked} / {classItem.max_capacity} booked
                        </p>
                      </div>
                    </div>
                  )}

                  {classItem.total_waitlist > 0 && (
                    <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                      <p className="text-sm text-yellow-800">
                        <strong>{classItem.total_waitlist}</strong> {classItem.total_waitlist === 1 ? 'person is' : 'people are'} on the waitlist
                      </p>
                    </div>
                  )}
                </div>
              </div>

              <div className="border-t pt-6">
                <button
                  onClick={() => setShowBookingModal(true)}
                  disabled={isFull}
                  className={`w-full py-4 px-6 rounded-lg font-semibold text-lg transition-colors ${
                    isFull
                      ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                      : 'bg-blue-600 text-white hover:bg-blue-700'
                  }`}
                >
                  {isFull ? 'Class Full - Join Waitlist' : 'Book This Class'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {showBookingModal && classItem && (
        <BookingModal
          classItem={classItem}
          location={location}
          onClose={() => setShowBookingModal(false)}
          onSuccess={handleBookingSuccess}
        />
      )}
    </>
  );
}
