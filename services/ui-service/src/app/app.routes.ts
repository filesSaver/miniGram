import { Routes } from '@angular/router';
import { HomeComponent } from './home/home';
import { GroupDetailComponent } from './group-detail/group-detail';
import { TopicDetailComponent } from './topic-detail/topic-detail';

export const routes: Routes = [
  { path: '', component: HomeComponent },
  { path: 'group/:groupId', component: GroupDetailComponent },
  { path: 'group/:groupId/topic/:topicId', component: TopicDetailComponent },
];
