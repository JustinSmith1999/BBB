export interface MindbodyClass {
  id: string;
  classScheduleId: string;
  location: {
    id: number;
    name: string;
  };
  classDescription: {
    id: number;
    name: string;
    description: string;
    imageUrl?: string;
    level?: string;
  };
  staff?: {
    id: number;
    name: string;
    imageUrl?: string;
  };
  startDateTime: string;
  endDateTime: string;
  maxCapacity: number;
  webCapacity: number;
  totalBooked: number;
  totalBookedWaitlist: number;
  isAvailable: boolean;
  isCanceled: boolean;
  isWaitlistAvailable: boolean;
  virtualStreamLink?: string;
}

export interface MindbodyClient {
  id: string;
  uniqueId: string;
  firstName: string;
  lastName: string;
  email: string;
  mobilePhone?: string;
  birthDate?: string;
}

export interface ClassBookingRequest {
  classId: string;
  clientId: string;
  test?: boolean;
  sendEmail?: boolean;
  waitlist?: boolean;
}

export interface GetClassesParams {
  startDate?: string;
  endDate?: string;
  locationIds?: number[];
  classScheduleIds?: number[];
  classDescriptionIds?: number[];
  staffIds?: number[];
  limit?: number;
  offset?: number;
}

const MINDBODY_PROXY_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/mindbody-proxy`;

async function callMindbodyAPI(
  endpoint: string,
  siteId: string,
  apiKey: string,
  method: string = 'GET',
  body?: any
) {
  const headers = {
    'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
  };

  const response = await fetch(MINDBODY_PROXY_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      endpoint,
      method,
      body,
      siteId,
      apiKey,
    }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'MindBody API request failed');
  }

  return response.json();
}

export async function getClasses(
  siteId: string,
  apiKey: string,
  params: GetClassesParams = {}
): Promise<MindbodyClass[]> {
  const queryParams = new URLSearchParams();

  if (params.startDate) queryParams.append('StartDate', params.startDate);
  if (params.endDate) queryParams.append('EndDate', params.endDate);
  if (params.locationIds?.length) {
    params.locationIds.forEach(id => queryParams.append('LocationIds', id.toString()));
  }
  if (params.classScheduleIds?.length) {
    params.classScheduleIds.forEach(id => queryParams.append('ClassScheduleIds', id.toString()));
  }
  if (params.classDescriptionIds?.length) {
    params.classDescriptionIds.forEach(id => queryParams.append('ClassDescriptionIds', id.toString()));
  }
  if (params.staffIds?.length) {
    params.staffIds.forEach(id => queryParams.append('StaffIds', id.toString()));
  }
  if (params.limit) queryParams.append('Limit', params.limit.toString());
  if (params.offset) queryParams.append('Offset', params.offset.toString());

  const endpoint = `/class/classes?${queryParams.toString()}`;
  const response = await callMindbodyAPI(endpoint, siteId, apiKey);

  return response.Classes || [];
}

export async function addClientToClass(
  siteId: string,
  apiKey: string,
  booking: ClassBookingRequest
): Promise<any> {
  const endpoint = '/class/addclienttoclass';
  return callMindbodyAPI(endpoint, siteId, apiKey, 'POST', {
    ClientId: booking.clientId,
    ClassId: booking.classId,
    Test: booking.test || false,
    SendEmail: booking.sendEmail !== false,
    Waitlist: booking.waitlist || false,
  });
}

export async function getClient(
  siteId: string,
  apiKey: string,
  clientId: string
): Promise<MindbodyClient | null> {
  const endpoint = `/client/clients?ClientIds=${clientId}`;
  const response = await callMindbodyAPI(endpoint, siteId, apiKey);

  return response.Clients?.[0] || null;
}

export async function addOrUpdateClient(
  siteId: string,
  apiKey: string,
  client: Partial<MindbodyClient>
): Promise<MindbodyClient> {
  const endpoint = '/client/addclient';
  const response = await callMindbodyAPI(endpoint, siteId, apiKey, 'POST', {
    FirstName: client.firstName,
    LastName: client.lastName,
    Email: client.email,
    MobilePhone: client.mobilePhone,
    BirthDate: client.birthDate,
  });

  return response.Client;
}

export async function removeClientFromClass(
  siteId: string,
  apiKey: string,
  clientId: string,
  classId: string,
  lateCancel: boolean = false
): Promise<any> {
  const endpoint = '/class/removeclientfromclass';
  return callMindbodyAPI(endpoint, siteId, apiKey, 'POST', {
    ClientId: clientId,
    ClassId: classId,
    LateCancel: lateCancel,
    SendEmail: true,
  });
}
