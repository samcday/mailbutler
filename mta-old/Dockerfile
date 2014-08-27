FROM ubuntu:latest
MAINTAINER Sam <me@samcday.com.au>

RUN apt-get update
RUN apt-get install -y curl build-essential python
RUN mkdir /opt/node
RUN curl http://nodejs.org/dist/v0.10.20/node-v0.10.20-linux-x64.tar.gz | tar -C /opt/node --strip-components 1 -zxvf -
RUN /opt/node/bin/npm -g install Haraka
RUN mkdir /srv/mailbutler-mta
ADD . /srv/mailbutler-mta

CMD ["/opt/node/bin/haraka", "-c", "/srv/mailbutler-mta"]